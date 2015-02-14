/**
 * WebSocket transport. Needed because browsers can't handle TCP sockets
 * so we use separate WebSocket server to proxy messages into TCP data
 * packets. Available for both Node.js and Browser platforms.  
 * **NOTE**: `WsTransport` is exported as a module.
 * @example var WsTransport = require("bitmessage/lib/net/ws");
 * @module bitmessage/lib/net/ws
 */

"use strict";

var objectAssign = Object.assign || require("object-assign");
var inherits = require("inherits");
var WebSocket = require("ws");  // jshint ignore:line
var assert = require("../_util").assert;
var PPromise = require("../platform").Promise;
var structs = require("../structs");
var messages = require("../messages");
var BaseTransport = require("./base");

var WebSocketServer = WebSocket.Server;
var getmsg = BaseTransport._getmsg;
var unmap = BaseTransport._unmap;

/**
 * WebSocket transport class. Implements [base transport
 * interface]{@link module:bitmessage/lib/net/base.BaseTransport}.
 * @param {Object=} opts - Transport options
 * @param {Array} opts.seeds - Bootstrap nodes (none by default)
 * @param {Object} opts.services -
 * [Service features]{@link module:bitmessage/structs.ServicesBitfield}
 * provided by this node (`NODE_NETWORK` by default)
 * @param {(Array|string|Buffer)} opts.userAgent -
 * [User agent]{@link module:bitmessage/user-agent} of this node
 * (bitmessage's by default)
 * @param {number[]} opts.streamNumbers - Streams accepted by this node
 * (1 by default)
 * @param {number} opts.port - Incoming port of this node (8444 by
 * default)
 * @constructor
 * @static
 */
function WsTransport(opts) {
  WsTransport.super_.call(this);
  objectAssign(this, opts);
  this.seeds = this.seeds || [];
}

inherits(WsTransport, BaseTransport);

function getfrom(client) {
  return unmap(client._socket.remoteAddress) + ":" + client._socket.remotePort;
}

WsTransport.prototype._sendVersion = function() {
  return this.send(messages.version.encode({
    services: this.services,
    userAgent: this.userAgent,
    streamNumbers: this.streamNumbers,
    port: this.port,
    remoteHost: this._client._socket.remoteAddress,
    remotePort: this._client._socket.remotePort,
  }));
};

WsTransport.prototype._handleTimeout = function() {
  var client = this._client;
  // TODO(Kagami): We may also want to close connection if it wasn't
  // established within minute.
  client._socket.setTimeout(20000);
  client._socket.on("timeout", function() {
    client.close();
  });
  this.on("established", function() {
    // Raise timeout up to 10 minutes per spec.
    // TODO(Kagami): Send ping frame every 5 minutes as PyBitmessage.
    client._socket.setTimeout(600000);
  });
};

WsTransport.prototype._setupClient = function(client, accepted) {
  var self = this;
  self._client = client;
  var verackSent = false;
  var verackReceived = false;
  var established = false;

  client.on("open", function() {
    // NOTE(Kagami): This handler shouldn't be called at all for
    // accepted sockets but let's be sure.
    if (!accepted) {
      // NOTE(Kagami): We may set timeout only after connection was
      // opened because socket may not yet be available when
      // `_setupClient` is called.
      self._handleTimeout();
      self.emit("open");
      self._sendVersion();
    }
  });

  client.on("message", function(data, flags) {
    var decoded;
    if (!flags.binary) {
      // TODO(Kagami): Send `error` message and ban node for some time
      // if there were too many errors?
      return self.emit("warning", new Error(
        "Peer " + getfrom(client) + " sent non-binary data"
      ));
    }
    try {
      decoded = structs.message.decode(data);
    } catch (err) {
      return self.emit("warning", new Error(
        "Message decoding error from " + getfrom(client) + ": " + err
      ));
    }
    self.emit("message", decoded.command, decoded.payload, decoded);
  });

  // High-level message processing.
  self.on("message", function(command) {
    if (!established) {
      // TODO: Process version data.
      // TODO: Disconnect if proto version < 3.
      if (command === "version") {
        if (verackSent) {
          return;
        }
        self.send("verack");
        verackSent = true;
        if (accepted) {
          self._sendVersion();
        } else if (verackReceived) {
          established = true;
          self.emit("established");
        }
      } else if (command === "verack") {
        verackReceived = true;
        if (verackSent) {
          established = true;
          self.emit("established");
        }
      }
    }
  });

  client.on("error", function(err) {
    self.emit("error", err);
  });

  client.on("close", function() {
    self.emit("close");
    delete self._client;
  });
};

WsTransport.prototype.bootstrap = function() {
  return PPromise.resolve([].concat(this.seeds));
};

/**
 * Connect to a WebSocket node. Connection arguments are the same as for
 * [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket).
 */
WsTransport.prototype.connect = function(address, protocols, options) {
  assert(!this._client, "Already connected");
  assert(!this._server, "Already listening");
  // `new` doesn't work with `apply`, so passing all possible arguments
  // manually.
  this._setupClient(new WebSocket(address, protocols, options));
};

/**
 * Listen for incoming WebSocket connections. Listen arguments are the
 * same as for
 * [WebSocketServer](https://github.com/websockets/ws#server-example).
 * Available only for Node platform.
 */
WsTransport.prototype.listen = function(options, callback) {
  assert(!this._client, "Already connected");
  assert(!this._server, "Already listening");

  var self = this;
  var server = self._server = new WebSocketServer(options, callback);

  // TODO(Kagami): We may want to specify some limits for number of
  // connected users.
  server.on("connection", function(client) {
    var addr = client._socket.remoteAddress;
    var port = client._remotePort;
    var i;

    // NOTE(Kagami): O(n) search because `clients` array is already
    // provided by `ws` library. We may want to optmize it though and
    // also disable `clientTracking` option.
    for (i = 0; i < server.clients.length; i++) {
      if (server.clients[i] !== client &&
          server.clients[i]._socket.remoteAddress === addr) {
        // NOTE(Kagami): Doesn't allow more than one connection per IP.
        // This may obstruct people behind NAT but we copy
        // PyBitmessage's behavior here.
        client.close();
        return self.emit("warning", new Error(
          unmap(addr) + " was tried to create second connection"
        ));
      }
    }

    var transport = new self.constructor(self);
    var accepted = true;
    transport._setupClient(client, accepted);
    transport._handleTimeout();
    self.emit("connection", transport, unmap(addr), port);
    // Emit "open" manually because it won't be fired for already opened
    // socket.
    transport.emit("open");
  });

  server.on("error", function(err) {
    self.emit("error", err);
  });
};

WsTransport.prototype.send = function() {
  if (this._client) {
    // TODO(Kagami): `mask: true` doesn't work with Chromium 40. File a
    // bug to ws bugtracker.
    this._client.send(getmsg(arguments), {binary: true});
  } else {
    throw new Error("Not connected");
  }
};

WsTransport.prototype.broadcast = function() {
  var data = getmsg(arguments);
  if (this._server) {
    this._server.clients.forEach(function(client) {
      client.send(data, {binary: true});
    });
  } else {
    throw new Error("Not listening");
  }
};

WsTransport.prototype.close = function() {
  if (this._client) {
    this._client.close();
  } else if (this._server) {
    // `ws` server terminates immediately without any events.
    this._server.close();
    this.emit("close");
    delete this._server;
  }
};

module.exports = WsTransport;