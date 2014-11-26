#!/bin/env node

var async   = require('async');
var express = require('express');
// use drop-in replacement for http module to follow redirects, see: http://syskall.com/how-to-follow-http-redirects-in-node-dot-js/
var http    = require('follow-redirects').http;
var StringDecoder = require('string_decoder').StringDecoder;
var url     = require('url');

var resolvers = require('./resolvers');

/**
 *  Define the sample application.
 */
var App = function() {
    var CACHE_PERIOD = 5 * 60 * 1000; // ms

    // In-memory key-value store
    var db = {};

    //  Scope.
    var self = this;

    /*  ================================================================  */
    /*  Helper functions.                                                 */
    /*  ================================================================  */

    /**
     *  Set up server IP address and port # using env variables/defaults.
     */
    self.setupVariables = function() {
        //  Set the environment variables we need.
        self.ipaddress = process.env.OPENSHIFT_NODEJS_IP;
        self.port      = process.env.OPENSHIFT_NODEJS_PORT || 8080;

        if (typeof self.ipaddress === "undefined") {
            //  Log errors on OpenShift but continue w/ 127.0.0.1 - this
            //  allows us to run/test the app locally.
            console.warn('No OPENSHIFT_NODEJS_IP var, using 127.0.0.1');
            self.ipaddress = "127.0.0.1";
        };
    };

    /**
     *  terminator === the termination handler
     *  Terminate server on receipt of the specified signal.
     *  @param {string} sig  Signal to terminate on.
     */
    self.terminator = function(sig){
        if (typeof sig === "string") {
           console.log('%s: Received %s - terminating sample app ...',
                       Date(Date.now()), sig);
           process.exit(1);
        }
        console.log('%s: Node server stopped.', Date(Date.now()) );
    };

    /**
     *  Setup termination handlers (for exit and a list of signals).
     */
    self.setupTerminationHandlers = function(){
        //  Process on exit and signals.
        process.on('exit', function() { self.terminator(); });

        // Removed 'SIGPIPE' from the list - bugz 852598.
        ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
         'SIGBUS', 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGTERM'
        ].forEach(function(element, index, array) {
            process.on(element, function() { self.terminator(element); });
        });
    };

    /*  ================================================================  */
    /*  App server functions (main app logic here).                       */
    /*  ================================================================  */

    /**
     *  Create the routing table entries + handlers for the application.
     */
    self.createRoutes = function() {
        self.routes = {};

        self.routes['/json/query'] = function(req, res) {
            console.log("Request from: " + req.ip);

            async.map(resolvers.resolvers, getResult, function(err, results) {
                res.json({
                    error: err,
                    results: results
                });
            });
        }

        self.routes['/json/pagehit'] = function(req, res) {
            // count visiting this path as page hit
            enterPageHit(req);

            res.json(db);
        }

        self.routes['/json/stats'] = function(req, res) {
            res.json(db);
        }
    };

    /// A very simple hit counter
    function enterPageHit(req) {
        // enter hit into store
        var date = new Date;
        var day = date.getUTCFullYear() + "-" + (date.getUTCMonth() + 1) + "-" + date.getUTCDate();
        var keys = [
            "hits-by-day_" + day,
        ];
        keys.map(function(key) {
            var count = (key in db ? db[key] : 0);
            db[key] = count+1;
        });

        // convenience entries
        db["hits-today"] = db["hits-by-day_" + day]
    }

    function getResult(resolver, callback) {
        var cacheEntry = self.cache[resolver.name];
        if (cacheEntry) {
            console.log("CACHED: " + resolver.name)

            if (cacheEntry.timestamp > (new Date().getTime() - CACHE_PERIOD)) {
                // cache hit, return cached result
                cacheEntry.cached = true;
                return callback(null, cacheEntry);
            }

            // entry out of date, remove
            delete cacheEntry;
        }

        return callResolver(resolver, callback);
    }

    function callResolver(resolver, callback) {
        function createResult(resolver, data) {
            var result = {};
            result.name = resolver.name;
            result.link = resolver.link;
            result.data = data;
            result.timestamp = new Date().getTime();
            return result;
        }

        console.log("START: " + resolver.name)

        var query = {
            options: resolver.request.options ? resolver.request.options : resolver.request.getOptions(),
            body: resolver.request.body
        }

        // TODO: Let the result do the request on their own.
        // We don't care *how* each resolver retrieves its data, hence don't hardcode the method here
        req = http.request(query.options, function(res) {
            var decoder = new StringDecoder('utf8');

            if (resolver.onResponse) {
                var data = resolver.onResponse(query, res)
                if (data) {
                    var result = createResult(resolver, data)
                    self.cache[resolver.name] = result
                    callback(null, result);
                    return;
                }
            }

            var buffer = '';
            res.on('data', function(chunk) {
                buffer += decoder.write(chunk);
            });
            res.on('end', function() {
                console.log("END: " + resolver.name)

                var data = resolver.onData(buffer);
                var result = createResult(resolver, data);
                self.cache[resolver.name] = result
                callback(null, result);
            });
        }).on('error', function(e) {
            console.log("ERROR: " + resolver.name + " " + e.message)

            var errorMessage = 'Failed to fetch URL: ' + url + '. Message: ' + e.message;
            console.warn('Error: ' + errorMessage);
            result = createResult(resolver, {error: errorMessage});
            callback(null, result);
        });

        req.on('socket', function (socket) {
            socket.setTimeout(5000);
            socket.on('timeout', function() {
                console.log("TIMEOUT: " + resolver.name);
                req.abort();
            });
        });

        if (query.body) {
            req.setHeader('Content-Length', query.body.length)
            req.write(query.body);
        }
        req.end();
    }

    /**
     *  Initialize the server (express) and create the routes and register
     *  the handlers.
     */
    self.initializeServer = function() {
        self.cache = {};
        self.createRoutes();
        self.server = express();
        self.server.configure(function() {
            self.server.use(express.static(__dirname + '/public'))
        });

        //  Add handlers for the app (from the routes).
        for (var r in self.routes) {
            self.server.get(r, self.routes[r]);
        }
    };

    /**
     *  Initializes the sample application.
     */
    self.initialize = function() {
        self.setupVariables();
        self.setupTerminationHandlers();

        // Create the express server and routes.
        self.initializeServer();
    };

    /**
     *  Start the server (starts up the sample application).
     */
    self.start = function() {
        //  Start the app on the specific interface (and port).
        self.server.listen(self.port, self.ipaddress, function() {
            console.log('%s: Node server started on http://%s:%d ...',
                        Date(Date.now() ), self.ipaddress, self.port);
        });
    };

};   /*  Sample Application.  */

/**
 *  main():  Main code.
 */
var app = new App();
app.initialize();
app.start();
