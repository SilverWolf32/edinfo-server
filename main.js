let express = require("express")()
let expressStatic = require("serve-static") // comes with Express
let server = require("http").Server(express)
let socketio = require("socket.io")(server)
let requestpromise = require("request-promise-native")
var path = require("path")

var fs = require("fs")

var util = require("util")
fs.readFilePromise = util.promisify(fs.readFile)
fs.writeFilePromise = util.promisify(fs.writeFile)

// rate limiting for EDSM
let rateLimitPool = null
let rateLimitMax = null
let rateLimitTimeToFull = null // seconds
let rateLimitSafeInterval = 5 // seconds
let rateLimitLastUsed = null

let rateLimitEstimatedPool = null
let rateLimitEstimatedTimeToFull = null
let rateLimitEstimateRegen = rateLimitSafeInterval // seconds to regenerate 1 request

let systemsCache = null

// path.normalize() and path.join() to correctly handle Windows paths
var journalDir = path.normalize(path.join(require("os").homedir(), "Saved Games/Frontier Developments/Elite Dangerous"))
var hudFile = path.normalize(path.join(require("os").homedir(), "AppData/Local/Frontier Developments/Elite Dangerous/Options/Graphics/GraphicsConfigurationOverride.xml"))

// Node.js argv: arguments start at argv[2]!
if (process.argv.length > 2) {
	journalDir = path.normalize(process.argv[2])
	console.log("Set journal path to", journalDir)
}
if (process.argv.length > 3) {
	hudFile = path.normalize(process.argv[3])
	console.log("Set HUD file path to", hudFile)
}

var cmdrInfo = {
	"cmdrName": null
}
var shipInfo = {
	"type": null,
	"name": null,
	"id": null
}

/* express.get("/", function(request, result) {
	result.sendFile(__dirname + "/app/index.html")
}) */
express.use(expressStatic("app"))

express.get("/api/location", function(request, result) {
	// result.sendFile(__dirname + "/test.html")
	result.json({
		"system": currentSystem,
		"station": currentStation
	})
})

socketio.on("connection", function(socket) {
	console.log("Connected")
	sendCurrentInfo()
	socket.on("disconnect", function() {
		console.log("Disconnected")
	})
})

server.listen(3000, function() {
	console.log("Server started, listening on port 3000")
})

/* setInterval(function() {
	let data = Date.now() / 1000
	console.log("Sending: "+data)
	socketio.emit("new-data", data)
}, 500) */

// set up journal watching

var chokidar = require("chokidar")

var watching = false

var latestEvent = null
var currentSystem = null
var currentStation = null

fs.readFile(path.join(journalDir, "Status.json"), "utf8", function(error, data) {
	if (error) {
		// throw(error)
		console.log(error)
		// tru again with fake journal
		journalDir = "/tmp/ed-fake-journal.log"
		fs.readFile(journalDir, "utf8", function(error, data) {
			if (error) {
				// throw(error)
				console.log(error)
				return
			}
			console.log("Fake journal is accessible.", data)
		})
	} else {
		console.log("Journal is accessible.", data)
	}

	console.log("Watching " + journalDir)

	var watcher = chokidar.watch(journalDir, {
		ignored: /(^|[\/\\])\../,
		useFsEvents: false
	})

	watcher.on("ready", function() {
		console.log("Watcher is ready: " + JSON.stringify(watcher.getWatched()))
		watching = true
	})
	watcher.on("error", function(error) {
		console.log("Watcher error!", error)
	})
	watcher.on("raw", function(event, path, details) {
		// console.log("Raw event info:", event, path, details)
	})

	watcher.on("add", function(addedPath) {
		updateJournal(addedPath)
	})
	watcher.on("change", function(changedPath) {
		updateJournal(changedPath)
	})
	
	function updateJournal(path) {
		if (!watching) {
			// console.log("Received event, but chokidar not ready")
			// return // chokidar spits out lots of update events before it's ready
		}
		console.log("Received journal data in " + path)
		fs.readFile(path, "utf8", function(error, data) {
			if (error) {
				throw(error)
			}
			console.log("Received data:", data)
			var events = data.split("\n")
			// remove blank lines
			events = events.filter(line => line != undefined && line != null && line != "")
			// only last several lines to save time
			// events = events.slice(events.length - 5)
			console.log("Event array length:", events.length)
			// console.log("Events:", events)
			for (var i = 0; i < events.length; i++) {
				if (i > 10000) {
					break
				}
				let eventStr = events[i]
				let event = null
				// console.log("Event: " + event)
				try {
					event = JSON.parse(eventStr)
				} catch (error) {
					// ignore malformed events
					console.log("Malformed event: " + eventStr)
					continue
				}
				
				// filter for Location, FSDJump events
				if (event.event == "Location") {
					if (event.StarSystem != null) {
						currentSystem = event.StarSystem
					}
					if (event.Docked) {
						currentStation = event.StationName
					} else {
						currentStation = null
					}
				} else if (event.event == "FSDJump") {
					currentSystem = event.StarSystem
					currentStation = null // can't be at a station if just FSD jumped
				} else if (event.event == "SupercruiseEntry" || event.event == "SupercruiseExit") {
					currentSystem = event.StarSystem
					currentStation = null // can't be at a station if just entered/exited SC
				} else if (event.event == "Docked") {
					currentSystem = event.StarSystem
					currentStation = event.StationName
				} else if (event.event == "Undocked") {
					if (event.StarSystem != null) {
						currentSystem = event.StarSystem
					}
					currentStation = null
				} else if (event.event == "LoadGame" || event.event == "Loadout") {
					if (event.Commander != undefined) {
						cmdrInfo.cmdrName = event.Commander
					}
					shipInfo.type = event.Ship
					shipInfo.name = event.ShipName
					shipInfo.id   = event.ShipIdent
				} else if (event.event == "Statistics") {
					
				} else {
					continue // not the right kind of event, so skip it
				}
				
				if (latestEvent == null) { // no current event
					latestEvent = event
				} else {
					date1 = new Date(latestEvent.timestamp)
					date2 = new Date(event.timestamp)
					if (date2 >= date1) { // this one is newer
						latestEvent = event
					} else {
						console.log("New event out of order!", event)
						continue
					}
				}
				sendCurrentInfo()
			}
		})
	}
})

function sendCurrentInfo() {
	{
		payload = {
			"system": currentSystem,
			"station": currentStation
		}
		data = JSON.stringify(payload, null, "\t")
		console.log("Broadcasting location update:", data)
		socketio.emit("update-location", data)
	}
	{
		payload = {
			"cmdr": cmdrInfo,
			"ship": shipInfo
		}
		data = JSON.stringify(payload, null, "\t")
		console.log("Broadcasting CMDR update:", data)
		socketio.emit("update-cmdr", data)
	}
}
function sendStatusUpdate(message, clientID) {
	console.log("Sending status update to client", clientID)
	if (clientID == null) {
		return
	}
	payload = {
		"message": message
	}
	data = JSON.stringify(payload, null, "\t")
	// console.log("Sending status update:", data)
	socketio.to(clientID).emit("status-update", data)
}

express.get("/api/nearby-stations", function(request, result) {
	try {
		var r = request.query.r
	} catch {
		r = 1
	}
	clientID = request.query.clientID
	if (clientID == undefined) {
		clientID = null
	}
	getNearbyStations(r, clientID)
	.then(function(nearbyStations) {
		result.json(nearbyStations)
	})
	.catch(function(error) {
		console.log("Sending error:", error)
		if (error.statusCode == undefined) {
			error.statusCode = 500 // generic server error
		}
		result.status(error.statusCode)
		result.json(error)
	})
})

async function getSystemInfo(system, radius, clientID) {
	sendStatusUpdate("Loading systems cache...", clientID)
	if (systemsCache != null) {
		cachePromise = Promise.resolve(systemsCache)
	} else {
		cachePromise = fs.readFilePromise("systemsPopulated.json")
		.then(function(data) {
			systemsCache = JSON.parse(data)
			return systemsCache
		})
	}
	
	return cachePromise.then(function(systems) {
		sendStatusUpdate("Finding nearby systems in cache...", clientID)
		
		let thisSystem = systems.find((candidateSystem) => {
			return candidateSystem.name == system
		})
		
		if (thisSystem == null) {
			let error = new Error()
			error.name = "CacheError"
			error.message = "Couldn't find system in cache"
			error.statusCode = 404
			return Promise.reject(error)
		}
		
		let systemsFiltered = 0
		let foundSystems = []
		for (let candidateSystem of systems) {
			let dx = candidateSystem.coords.x - thisSystem.coords.x
			let dy = candidateSystem.coords.y - thisSystem.coords.y
			let dz = candidateSystem.coords.z - thisSystem.coords.z
			
			let distance = Math.sqrt(dx**2 + dy**2 + dz**2)
			
			systemsFiltered++
			sendStatusUpdate("Finding nearby systems ["+systemsFiltered+"/"+systems.length+"]...", clientID)
			
			if (distance <= radius) {
				candidateSystem.distance = distance
				foundSystems.push(candidateSystem)
			}
		}
		
		return foundSystems
	})
	.catch(function(error) {
		// return Promise.reject(error)
		
		console.log("Couldn't read systems cache; falling back to EDSM")
		sendStatusUpdate("Getting systems from EDSM...", clientID)
		
		return requestpromise({
			"uri": "https://www.edsm.net/api-v1/sphere-systems?systemName="+system+"&radius="+radius+"&showId=1",
			resolveWithFullResponse: true, // get headers
			simple: false // don't auto-reject non-2xx error codes, we need the headers
		})
		.then(function(response) {
			let headers = response.headers
			
			/* rateLimitPool = Number(headers["x-rate-limit-remaining"])
			rateLimitMax = Number(headers["x-rate-limit-limit"])
			rateLimitTimeToFull = Number(headers["x-rate-limit-reset"])
			rateLimitEstimatedPool = rateLimitPool
			rateLimitEstimatedTimeToFull = rateLimitTimeToFull
			rateLimitLastUsed = new Date()
			sendRateLimitInformation() */
			
			if (response.statusCode != 200) {
				return Promise.reject(response)
			}
			
			return response.body
		})
		.then(function(json) {
			console.log("Parsing the JSON")
			sendStatusUpdate("Parsing EDSM results...", clientID)
			try {
				var systems = JSON.parse(json)
			} catch {
				console.log("Invalid JSON from EDSM")
			}
			return systems
		})
		.catch(function(error) {
			return Promise.reject(error)
		})
	})
}
async function getStationsInSystems(systems, clientID) {
	return fs.readFilePromise("stations.json")
	.then(function(data) {
		return JSON.parse(data)
	})
	.then(function(stations) {
		let systemNames = systems.map((system) => system.name)
		console.log("Systems to search:", JSON.stringify(systemNames))
		console.log("Filtering stations from cache")
		sendStatusUpdate("Filtering stations from cache...", clientID)
		return stations.filter((station) => {
			return systemNames.includes(station.systemName)
		})
	})
	.then(function(stations) {
		console.log("Filtering done")
		// console.log(stations)
		return stations
	})
	.then(function(stations) {
		console.log("Adding distances")
		sendStatusUpdate("Adding distances...", clientID)
		// slap distances on them
		return stations.map((station) => {
			let system = systems.filter((system) => system.id == station.systemId)[0]
			// console.log(system.name)
			station.distance = system.distance
			return station
		})
	})
	.catch(async function(error) {
		console.log("Couldn't read stations cache; falling back to EDSM")
		console.log(error)
		
		var promises = []
		sendStatusUpdate("Getting stations from EDSM...", clientID)
		for (i = 0; i < systems.length; i++) {
			let system = systems[i]
			// console.log(system)
			console.log("Getting stations for " + system.name)
			promises.push(requestpromise({
				uri: "https://www.edsm.net/api-system-v1/stations/?systemId="+system.id,
				resolveWithFullResponse: true // get headers
			}))
		}
		return await Promise.all(promises)
		.then(function(stationResponseArray) {
			console.log("Station API calls collected")
			let stationHeadersArray = stationResponseArray.map((response) => response.headers)
			let rateLimitPoolArray = stationHeadersArray.map((headers) => headers["x-rate-limit-remaining"])
			let rateLimitLimitArray = stationHeadersArray.map((headers) => headers["x-rate-limit-limit"])
			let rateLimitTimeToFullArray = stationHeadersArray.map((headers) => headers["x-rate-limit-reset"])
			// see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/apply#Using_apply_and_built-in_functions
			rateLimitPool = Math.min.apply(null, rateLimitPoolArray)
			rateLimitMax = Math.min.apply(null, rateLimitLimitArray)
			rateLimitTimeToFull = Math.min.apply(null, rateLimitTimeToFullArray)
			rateLimitEstimatedPool = rateLimitPool
			rateLimitEstimatedTimeToFull = rateLimitTimeToFull
			rateLimitLastUsed = new Date()
			sendRateLimitInformation()
			
			let stationJSONarray = stationResponseArray.map((response) => response.body)
			return stationJSONarray
		})
		.then(function(stationJSONarray) {
			let nearbyStations = []
			for (i = 0; i < stationJSONarray.length; i++) {
				let stationsJSON = stationJSONarray[i]
				try {
					var systemInfo = JSON.parse(stationsJSON)
				} catch {
					console.log("Invalid station JSON from EDSM: "+stationsJSON)
				}
				console.log(systemInfo)
				
				// find system
				let systemId = systemInfo.id
				let system = null
				for (j = 0; j < systems.length; j++) {
					if (systems[j].id == systemId) {
						system = systems[j]
						break
					}
				}
				
				let stations = systemInfo.stations
				for (j = 0; j < stations.length; j++) {
					stations[j].systemName = system.name
					stations[j].distance = system.distance
					nearbyStations.push(stations[j])
				}
				// console.log("Adding " + JSON.stringify(stations))
			}
			return nearbyStations
		})
	})
}
async function getNearbyStations(radius, clientID) {
	if (currentSystem == null) {
		let error = new Error()
		error.name = "InternalStateError"
		error.message = "No current system"
		error.statusCode = 500
		return Promise.reject(error)
	}
	// currentSystem = "Diaguandri"
	console.log("Getting stations near "+currentSystem+"...")
	return getSystemInfo(currentSystem, radius, clientID)
	.then(function(systems) {
		return getStationsInSystems(systems, clientID)
	})
	.then(function(nearbyStations) {
		nearbyStations.sort(function(a, b) {
			if (a.distance < b.distance) {
				return -1
			} else if (a.distance > b.distance) {
				return 1
			}
			// then sort by name
			if (a.name < b.name) {
				return -1
			} else if (a.name > b.name) {
				return 1
			}
			return 0
		})
		// console.log("--------")
		// console.log(nearbyStations)
		// result.json(systems)
		// result.json(nearbyStations)
		// return systems
		return nearbyStations
	})
	.catch(function(error) {
		// console.log(error)
		return Promise.reject(error)
	})
}

function getRateLimitInformation() {
	return {
		"available": rateLimitPool,
		"max": rateLimitMax,
		"timeToFull": rateLimitTimeToFull,
		"asOf": rateLimitLastUsed,
		"estimatedAvailableNow": rateLimitEstimatedPool,
		"estimatedTimeToFull": rateLimitEstimatedTimeToFull
	}
}
express.get("/api/ratelimit", function(request, result) {
	result.json(getRateLimitInformation())
})
async function sendRateLimitInformation() {
	console.log("Sending rate limit information")
	socketio.emit("rate-limit-info", getRateLimitInformation())
}
async function sendRateLimitEstimate() {
	if (calcRateLimitEstimate() == false) {
		// return Promise.resolve("Nothing to do")
	}
	console.log("Sending rate limit estimate")
	return socketio.emit("rate-limit-estimate", {
		"estimatedAvailable": rateLimitEstimatedPool,
		"max": rateLimitMax,
		"estimatedTimeToFull": rateLimitEstimatedTimeToFull
	})
}
function calcRateLimitEstimate() {
	if (rateLimitLastUsed == null) {
		return false
	}
	let now = new Date()
	let timeElapsed = (now.getTime() - rateLimitLastUsed.getTime()) / 1000
	rateLimitEstimatedPool = rateLimitPool + Math.floor(timeElapsed/rateLimitEstimateRegen)
	rateLimitEstimatedTimeToFull = rateLimitTimeToFull - Math.round(timeElapsed)
	
	if (rateLimitEstimatedPool > rateLimitMax) {
		rateLimitEstimatedPool = rateLimitMax
	}
	if (rateLimitEstimatedTimeToFull < 0) {
		rateLimitEstimatedTimeToFull = 0
	}
	return true
}

express.get("/api/hudmatrix", function(request, result) {
	getHUDMatrix()
	.then(function (hudmatrix) {
		result.json(hudmatrix)
	})
	.catch(function (error) {
		console.log(error)
		result.json(String(error))
	})
})

var xml2js = require("xml2js")
xml2js.parseStringPromise = util.promisify(xml2js.parseString)

async function getHUDMatrix() {
	console.log("Fetching HUD...")
	
	// return Promise.reject("Not implemented")
	
	return fs.readFilePromise(hudFile, "utf8")
	.catch(function(error) {
		// throw(error)
		console.log(error)
		// tru again with fake journal
		hudFile = "/tmp/GraphicsConfigurationOverride.xml"
		return fs.readFilePromise(hudFile, "utf8")
		.then(function(data) {
			console.log("Fake HUD file is accessible.")
			return data
		})
		.catch(function(error) {
			// throw(error)
			console.log(error)
			return Promise.reject("No HUD file")
		})
	})
	.then(function(data) {
		console.log(data)
		return xml2js.parseStringPromise(data)
	})
	.then(function(data) {
		console.log("Parse result:", JSON.stringify(data, null, "\t"))
		
		let matrix = data.GraphicsConfig.GUIColour[0].Default[0]
		let red = matrix.MatrixRed[0].replace(/ /g, "").split(",").map((item) => Number(item))
		let green = matrix.MatrixGreen[0].replace(/ /g, "").split(",").map((item) => Number(item))
		let blue = matrix.MatrixBlue[0].replace(/ /g, "").split(",").map((item) => Number(item))
		/* let outMatrix = {
			"red": red,
			"green": green,
			"blue": blue
		} */
		let outMatrix = [red, green, blue]
		console.log("Matrix:", matrix)
		console.log("Out:", outMatrix)
		
		return Promise.resolve(outMatrix)
	}).catch(function(error) {
		console.log("Parsing failed:", error)
		return Promise.reject(error)
	})
}

express.get("/api/hudcolorfilter.svg", function(request, result) {
	var safariMode = request.query.safari
	if (safariMode == "true" || safariMode == "yes") {
		safariMode = 1
	}
	if (safariMode == "false" || safariMode == "no") {
		safariMode = 0
	}
	console.log("Safari mode:", safariMode)
	if (safariMode == undefined) {
		// client didn't specify, look at the user agent
		safariMode = false
		let userAgent = request.headers["user-agent"]
		console.log("User agent:", userAgent)
		if (/.*WebKit.*/.test(userAgent)) {
			console.log("HUD color filter: Safari mode")
			safariMode = 1 // Safari will stubbornly use sRGB for the matrix, we need to undo that
		}
		if (/.*Epiphany.*/.test(userAgent)) {
			console.log("HUD color filter: Actually Epiphany")
			safariMode = 2 // Epiphany needs the <feComponentTransfer />, but needs it to just be a no-op! Weird.
		}
		if (/.*Chrome.*/.test(userAgent)) {
			console.log("HUD color filter: Actually Chromium-based")
			safariMode = 0 // Chrome doesn't do this
		}
	}
	generateHUDFilterSVG(safariMode)
	.then(function(svg) {
		result.set("Content-Type", "application/svg")
		result.send(svg)
	})
	.catch(function (error) {
		console.log(error)
		result.json(String(error))
	})
})
express.get("/api/regenerate-hud-filter", function(request, result) {
	regenerateHUDFilterSVGFile()
	.then(function(fsResult) {
		result.send("<a href=\"/hudcolorfilter.svg\">SVG regenerated.</a>")
	})
	.catch(function(error) {
		console.log(error)
		result.json(String(error))
	})
})
async function generateHUDFilterSVG(safariMode=false) {
	return getHUDMatrix()
	.catch(function(error) {
		console.log("Couldn't get HUD matrix:", error)
		return [
			[1, 0, 0],
			[0, 1, 0],
			[0, 0, 1]
		]
	})
	.then(function(matrix) {
		console.log("Using matrix:", matrix)
		
		// see https://css-tricks.com/color-filters-can-turn-your-gray-skies-blue/
		
		// this is swapped from the Elite representation! In the top, out the side
		let fullMatrix = [
			[matrix[0][0], matrix[1][0], matrix[2][0], 0, 0],
			[matrix[0][1], matrix[1][1], matrix[2][1], 0, 0],
			[matrix[0][2], matrix[1][2], matrix[2][2], 0, 0],
			[0           , 0           , 0           , 1, 0],
		]
		
		/* fullMatrix = [
			[0, 0, 0, 0, 0],
			[1, 1, 1, 1, 0],
			[0, 0, 0, 0, 0],
			[0, 0, 0, 1, 0]
		] */
		
		let fullMatrixStr = fullMatrix.map((row) => row.join(" ")).join("\n")
		
		let svgFilter = `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
	<defs>
		<filter id="HUD" color-interpolation-filters="linearRGB">
			<feColorMatrix in="SourceGraphic" type="matrix" values="${fullMatrixStr}" />`
		if (safariMode == 1) {
			svgFilter += `
			<!-- this corrects for Safari always using sRGB, even if we tell it not to -->
			<feComponentTransfer>
				<feFuncR type="gamma" exponent="0.45" />
				<feFuncG type="gamma" exponent="0.45" />
				<feFuncB type="gamma" exponent="0.45" />
			</feComponentTransfer>`
		} else if (safariMode == 2) {
			svgFilter += `
			<!-- this corrects for Safari always using sRGB, even if we tell it not to -->
			<feComponentTransfer>
				<feFuncR type="gamma" exponent="1" />
				<feFuncG type="gamma" exponent="1" />
				<feFuncB type="gamma" exponent="1" />
			</feComponentTransfer>`
		}
		svgFilter += `
		</filter>
	</defs>
	<!-- <circle cx="64" cy="64" r="64" id="circle" fill="#FFA040" filter="url(#HUD)" /> -->
</svg>`
		console.log("Completed SVG filter:\n" + svgFilter)
		
		return svgFilter
	})
}
async function regenerateHUDFilterSVGFile() {
	console.log("Regenerating SVG")
	return generateHUDFilterSVG()
	.then(function(svg) {
		return fs.writeFilePromise("app/hudcolorfilter.svg", svg)
	})
}

express.get("/api/shipinfo", function(request, result) {
	result.json(shipInfo)
})
express.get("/api/cmdrinfo", function(request, result) {
	result.json(cmdrInfo)
})
