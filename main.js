let express = require("express")()
let expressStatic = require("serve-static") // comes with Express
let server = require("http").Server(express)
let socketio = require("socket.io")(server)
let requestpromise = require("request-promise-native")

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

var fs = require("fs")
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
	.then(function (nearbyStations) {
		result.json(nearbyStations)
	})
	.catch(function (error) {
		console.log(error)
		result.json(String(error))
	})
})

async function getNearbyStations(radius) {
	if (currentSystem == null) {
		return Promise.reject(new Error("No current system"))
	}
	// currentSystem = "Diaguandri"
	console.log("Getting stations near "+currentSystem+" from EDSM")
	return requestpromise("https://www.edsm.net/api-v1/sphere-systems?systemName="+currentSystem+"&radius="+radius+"&showId=1")
	.then(async function(json) {
		try {
			var systems = JSON.parse(json)
		} catch {
			console.log("Invalid JSON from EDSM")
		}
		var promises = []
		for (i = 0; i < systems.length; i++) {
			let system = systems[i]
			// console.log(system)
			promises.push(requestpromise("https://www.edsm.net/api-system-v1/stations/?systemId="+system.id))
		}
		return await Promise.all(promises)
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
		console.log("--------")
		console.log(nearbyStations)
		// result.json(systems)
		// result.json(nearbyStations)
		// return systems
		return nearbyStations
	})
	.catch(function(error) {
		console.log(error)
	})
}
