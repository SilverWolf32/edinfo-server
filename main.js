let express = require("express")()
let expressStatic = require("serve-static") // comes with Express
let server = require("http").Server(express)
let socketio = require("socket.io")(server)
let requestpromise = require("request-promise-native")

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
let rateLimitEstimateRegen = 5 // seconds to regenerate 1 request

/* express.get("/", function(request, result) {
	result.sendFile(__dirname + "/app/index.html")
}) */
express.use(expressStatic("app"))

express.get("/api", function(request, result) {
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

var path = require("path")
var chokidar = require("chokidar")

var watching = false

// path.normalize() and path.join() to correctly handle Windows paths
var journalDir = path.normalize(path.join(require("os").homedir(), "Saved Games/Frontier Developments/Elite Dangerous"))

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
			console.log("Received event, but chokidar not ready")
			return // chokidar spits out lots of update events before it's ready
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
					currentSystem = event.StarSystem
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
					currentSystem = event.StarSystem
					currentStation = null
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
	payload = {
		"system": currentSystem,
		"station": currentStation
	}
	data = JSON.stringify(payload, null, "\t")
	sendJournalEvent(data)
}

function sendJournalEvent(event) {
	console.log("Sending journal event: " + event)
	socketio.emit("new-data", event)
}

express.get("/api/nearby-stations", function(request, result) {
	try {
		var r = request.query.r
	} catch {
		r = 1
	}
	getNearbyStations(r)
	.then(function(nearbyStations) {
		result.json(nearbyStations)
	})
	.catch(function(error) {
		console.log("Sending error:", error)
		result.status(error.statusCode)
		result.json(error)
	})
})

async function getSystemInfo(system, radius) {
	return fs.readFilePromise("systemsWithoutCoordinates.json")
	.then(function(data) {
		return JSON.parse(data)
	})
	.then(function(json) {
		// console.log("Read file contents:", json)
		
		let error = new Error()
		error.name = "InternalStateError"
		error.message = "Unimplemented"
		error.statusCode = 500
		return Promise.reject(error)
	})
	.catch(function(error) {
		// return Promise.reject(error)
		
		console.log("Couldn't read systems cache; falling back to EDSM")
		
		return requestpromise({
			"uri": "https://www.edsm.net/api-v1/sphere-systems?systemName="+system+"&radius="+radius+"&showId=1",
			resolveWithFullResponse: true, // get headers
			simple: false // don't auto-reject non-2xx error codes, we need the headers
		})
		.then(function(response) {
			let headers = response.headers
			
			rateLimitPool = Number(headers["x-rate-limit-remaining"])
			rateLimitMax = Number(headers["x-rate-limit-limit"])
			rateLimitTimeToFull = Number(headers["x-rate-limit-reset"])
			rateLimitEstimatedPool = rateLimitPool
			rateLimitEstimatedTimeToFull = rateLimitTimeToFull
			rateLimitLastUsed = new Date()
			sendRateLimitInformation()
			
			if (response.statusCode != 200) {
				return Promise.reject(response)
			}
			
			return response.body
		})
		.catch(function(error) {
			return Promise.reject(error)
		})
	})
}
async function getStationsInSystems(systems) {
	return fs.readFilePromise("stations.json")
	.then(function(data) {
		return JSON.parse(data)
	})
	.then(function(json) {
		let error = new Error()
		error.name = "InternalStateError"
		error.message = "Unimplemented"
		error.statusCode = 500
		return Promise.reject(error)
	})
	.catch(async function(error) {
		console.log("Couldn't read stations cache; falling back to EDSM")
		
		var promises = []
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
	})
}
async function getNearbyStations(radius) {
	if (currentSystem == null) {
		let error = new Error()
		error.name = "InternalStateError"
		error.message = "No current system"
		error.statusCode = 500
		return Promise.reject(error)
	}
	// currentSystem = "Diaguandri"
	console.log("Getting stations near "+currentSystem+" from EDSM")
	return getSystemInfo(currentSystem, radius)
	.then(function(json) {
		console.log("Parsing the JSON")
		try {
			var systems = JSON.parse(json)
		} catch {
			console.log("Invalid JSON from EDSM")
		}
		return getStationsInSystems(systems)
		.then(function(stationJSONarray) {
			// console.log(stationJSONarray)
			let nearbyStations = []
			for (i = 0; i < stationJSONarray.length; i++) {
				try {
					let stationsJSON = stationJSONarray[i]
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
	rateLimitEstimatedTimeToFull = rateLimitTimeToFull - Math.floor(timeElapsed)
	
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
	
	let hudFile = path.normalize(path.join(require("os").homedir(), "AppData/Local/Frontier Developments/Elite Dangerous/Options/Graphics/GraphicsConfigurationOverride.xml"))
	
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
	generateHUDFilterSVG()
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
async function generateHUDFilterSVG() {
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
		<filter id="HUD">
			<feColorMatrix in="SourceGraphic" type="matrix" values="\n${fullMatrixStr}" />
		</filter>
	</defs>
	<circle cx="64" cy="64" r="64" id="circle" fill="#FFA040" filter="url(#HUD)" />
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

regenerateHUDFilterSVGFile()
.catch(function(error) {
	console.log(error)
})

