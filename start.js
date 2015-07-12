#!/usr/bin/env node

var exec = require('child_process').exec;

exec("/bin/bash -c 'cd /home/pi/PiThermServer && env $(cat app.env | xargs) /usr/local/bin/forever start server.js'",
	function(err, stdout, stderr) {
	if (err !== null) {
		console.log('exec error: ' + err);
	}
});
