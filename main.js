let express = require("express")()
let server = require("http").Server(express)
let socketio = require("socket.io")(server)

express.get("/", function(request, result) {
	result.sendFile(__dirname + "/test.html")
})

socketio.on("connection", function(socket) {
	console.log("Connected")
	socket.on("disconnect", function() {
		console.log("Disconnected")
	})
})

server.listen(3000, function() {
	console.log("Server started, listening on port 3000")
})

setInterval(function() {
	let data = Date.now() / 1000
	console.log("Sending: "+data)
	socketio.emit("new-data", data)
}, 500)
