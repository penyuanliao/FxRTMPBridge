/**
 * Created by Benson on 2017/12/22.
 */
const net = require("net");
const nURL = require('url');
const http = require("http");
const util = require("util");
const path = require("path");
const crypto = require("crypto");
const NetServer = require("./NetSocket.js").NetServer;
const NetSocket = require("./NetSocket.js").NetSocket;
var ProtoBuf;
var NSLog;
try {
    NSLog = require("fxNetSocket").Logger.getInstance();
} catch (e) {
    NSLog = require("../../ipllib/fxNetSocket").Logger.getInstance();
}
var SN_DF = 0;
const VALID_JSON   = new RegExp(/^[\],:{}\s]*$/);
const FIND_JSON    = new RegExp("(\{.+?\})(?={|$)", "g");
const FIND_CRLF    = new RegExp(/[\r\n]*/g);
const FIND_AT      = new RegExp(/'\\["\\\/bfnrtu]/g);
const FIND_CHAR    = new RegExp(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g);
const FIND_MARK    = new RegExp(/(?:^|:|,)(?:\s*\[)+/g);
const EventEmitter = require("events");
util.inherits(Server, EventEmitter);

const ProtoBufEnums = Object.freeze({
    rpcResMessage: "ctrl.rpc.RPCResMessage",
    rpcResQueues: "ctrl.rpc.ResQueues",
    rpcReqMessage: "ctrl.rpc.ReqMessage",
    rpcReqQueues: "ctrl.rpc.ReqQueues"
});
/**
 *
 * @param {Object} delegate
 * @param {Object} [options]
 * @param {String} [options.host] address
 * @param {Number} [options.port] port
 * @param {Boolean} [options.ipc] ipc chancel
 * @param {String} [options.sockPath] ipc chancel path
 * @param {Object} [options.protobufOptions] protobuf
 * @param {Boolean} [options.protobufOptions.enabled] support protobuf message
 * @param {String} [options.protobufOptions.enabled] protobuf file *.proto
 * @param {Boolean} [options.listen] listen socket port
 * @constructor Server
 */
function Server(delegate, options) {
    EventEmitter.call(this);
    this.delegate    = delegate;
    this.responders  = {};
    this.webhooks    = {};
    this.owners      = {};
    this.reqMethod   = {};
    this.clients     = {};
    this.clientsCnt  = 0;
    this.clientSN    = 0;
    this.clientsKeys = [];
    this.iProtobuf   = {
        builder: undefined,
        instances: {},
        enabled: false
    };
    if (typeof options == "undefined") options = {port:8797, protobufOptions: {enabled: false}};

    this.noResponseTimeout = 60000;
    if (typeof options.noResponseTimeout == "number") {
        this.noResponseTimeout = options.noResponseTimeout;
    }
    Object.defineProperty(this, "handle", {
        get:function () {
            if (typeof this.server != "undefined") return this.server.handle;
        },
        enumerable:false,
        configurable:false
    })
    Object.defineProperty(this, "getMemberCount", {
        get:function () {
            return this.clientsCnt;
        },
        enumerable:false,
        configurable:false
    })
    var protobufOptions = options.protobufOptions;
    if (typeof protobufOptions == "undefined") {
        protobufOptions = {
            enabled: false
        };
    }

    if (protobufOptions.enabled) {
        this.initProtoBuf(options.protobufOptions.file, function () {
            this.setup(options);
        }.bind(this));
    } else {
        this.setup(options);
    }

}

/**
 * initizal
 *
 * @param options
 * @private
 */
Server.prototype.setup = function (options) {
    this.server = new NetServer(options);
    this.server.setCollectSockets(false);
    this.server.on("connection", this.connection.bind(this));
    this.server.on("httpConnection", this.httpConnection.bind(this));
    this.server.on("completed", function () {
        this.emit("completed");
    }.bind(this))

};
//
Server.prototype.initProtoBuf = function (file, callback) {
    ProtoBuf = require('../../PlayerCenter/node_modules/protobufjs');
    const self = this;
    this.protoFile = file || "./service.proto";
    ProtoBuf.load(file).then(function (root) {
        self.iProtobuf = {
            builder: root,
            instances: {},
            enabled: true
        }
        if (callback) callback(root);
    });
}
Server.prototype.connection = function (socket) {
    var self = this;
    socket.sn = self.clientSN++;
    self.clients[String(socket.sn)] = new RPCClient(socket, this);
    self.clientsKeys = Object.keys(self.clients);
    self.clientsCnt++;
    socket.on("close", function () {
        self.clients[socket.sn] = undefined;
        delete self.clients[socket.sn];
        self.clientsKeys = Object.keys(self.clients);
        self.clientsCnt--;
    });
    socket.on("error", function (error) {
        if (socket.writable) socket.destroy();
    });
};
Server.prototype.httpConnection = function (req, res) {

    // console.log(path.basename(req.url), req["method"], req.headers);
    var ctype = req.headers["content-type"];
    var body = undefined;
    const self = this;
    if (ctype != "application/json") {
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error:"Request failed: unacceptable content-type: " + ctype, event:false}));
        return;
    }

    req.on("data", function onData(chunk) {
        if (typeof body == "undefined") body = Buffer.from(chunk);
        else body = Buffer.concat([body, chunk], body.length + chunk.length);
    })
    req.on("end", function onEnded() {
        const segments = req.url.split("/");
        var method = (segments[1] == "api") ? segments[1] + "/" + segments[2] : segments[1];//req.url.substr(1, req.url.length);
        var format;
        var data;
        var params;
        var json;
        if (typeof body != "undefined") {
            format = body.toString().replace(FIND_CRLF, "").match(FIND_JSON);
            if (format != null && VALID_JSON.test(body.toString().replace(FIND_AT, '@').replace(FIND_CHAR, ']').replace(FIND_MARK, ''))) {
                data = JSON.parse(format);
            } else {
                data = {};
            }
        } else {
            data = {};
        }
        params = data.params;
        data.params.urls = segments;
        json = {method:method, params:params};
        self.handleCall(json, {req:req, res:res}, callback);

    })
    var callback = function (err, result) {
        if (err) {
            if (!err.code) err.code = 400;
            if (typeof err == "string") err = {msg: err, code:400};
            res.writeHead(err.code, {'Content-Type': 'application/json'});
            result = err.msg;

        } else {
            res.writeHead(200, {'Content-Type': 'application/json'});
        }
        res.end(JSON.stringify(result));
    };

};
Server.prototype.expose = function (name, func, self) {

    if (typeof this.responders[name] != "undefined") {
        NSLog.log("warning", "Method overriding the '%s'.", name);
    }

    if (typeof func == "function") {
        this.responders[name] = func;

        if (self) {
            this.owners[name] = self;
        } else {
            this.owners[name] = this.delegate;
        }

    } else {
        NSLog.log("warning", "%s bound func not found.", name);
    }
};
Server.prototype.api = function (name, method, func, self) {
    if (typeof this.responders[name] != "undefined") {
        NSLog.log("warning", "Method overriding the '%s'.", name);
    }
    if (typeof method == "function") {
        func = method;
        method = undefined;
    }

    if (typeof func == "function") {
        this.responders[name] = func;
        this.reqMethod[name] = method.toUpperCase();

        if (self) {
            this.owners[name] = self;
        } else {
            this.owners[name] = this.delegate;
        }

    } else {

    }
}
Server.prototype.unexpose = function (name) {
    this.owners[name] = undefined;
    this.responders[name] = undefined;
    this.reqMethod[name] = undefined;
    delete this.owners[name];
    delete this.responders[name];
    delete this.reqMethod[name];
};
/**
 *
 * @param {String} [workspace] Unique action identifier inside this API.
 * @param {String} [url] Http url to send updates to.
 */
Server.prototype.webhook = function (workspace, url) {
    if (typeof this.webhooks[workspace] != "undefined") {
        NSLog.log("warning", "Method overriding the '%s'.", workspace);
        return;
    }

    if (typeof url == "string") {
        this.webhooks[workspace] = nURL.parse(url);
    } else {
        NSLog.log("error", "Add webhook (%s) url unkown '%s'.", workspace, url);
    }
}
Server.prototype.trigger = function (workspace, json) {
    const srcUrl = this.webhooks[workspace];
    const data = (typeof json != "string") ? JSON.stringify(json) : json;
    const self = this;
    const options = {
        port: srcUrl.port,
        host: srcUrl.hostname,
        method: "POST",
        path: srcUrl.path,
        headers: { 'Content-Type': 'application/json'}
    };
    if (typeof srcUrl != "undefined") {
        const req = http.request(options, function (response) {
            NSLog.log("info",'%s STATUS: %s', workspace, response.statusCode);
        });
        req.on("error", function (e) {
            NSLog.log("error",'%s :', workspace, e);
        });
        req.end(data);
    } else {
        NSLog.log("error", "Opps! Trigger (%s) a specific webhook is undefined.", workspace);
    }
};
Server.prototype.unwebhook = function (workspace) {
    this.webhooks[workspace] = undefined;
    delete this.webhooks[workspace];
};
Server.prototype.broadcast = function (action, result, current) {
    var keys = (typeof this.clientsKeys == "undefined") ? Object.keys(this.clients) : this.clientsKeys;
    var client;
    var msg = {
        action:action,
        result:result
    };
    for (var i = 0; i < keys.length; i++) {
        // this.clients[keys[i]].send(msg);
        client = this.clients[keys[i]];

        // if (client.configure.uuid === current.configure.uuid) continue;

        if (typeof client.sendTime == "undefined" || (new Date().getTime() - client.sendTime) > 20) {
            client.send(msg);
        } else {
            client.bulk(msg);
        }
    }
};
Server.prototype.getNativeServer = function () {
    return this.server.server;
}
/**
 *
 * @param {Object} [json]
 * @param {String} [json.method]
 * @param {Array} [json.params]
 * @param client
 * @param callback
 */
Server.prototype.handleCall = function (json, client, callback) {

    if (this.responders.hasOwnProperty(json.method) == false) {
        callback({code:400, msg:"Unknown API error method:" + json.method});
        callback = undefined;
        return;
    }
    var method = this.responders[json.method];
    var owner = this.owners[json.method];
    var timeout;
    if (typeof owner === "undefined") owner = this.delegate;

    try {
        timeout = setTimeout(function () {
            if (callback) callback(new Error("No response time out of call " + json.method));
            callback = undefined;
        }, this.noResponseTimeout);

        method.call(owner, json.params, client, function (err, result) {
            if (callback) {
                callback(err, result);
                callback = undefined;
                clearTimeout(timeout);
            } else {
                NSLog.log("error", "response has time out.");
            }

        });

        // method.apply(owner);
    } catch (e) {
        callback(e.toString());
        callback = undefined;
    }

};
Server.prototype.bundling = function (handle) {
    if (typeof this.server != "undefined" && this.server.options.listen == false) {
        this.server.bundling(handle);
        return true;
    } else {
        return false;
    }
}
Server.prototype.md5 = function (string) {
    return crypto.createHash("md5").update(string).digest("hex");
}
util.inherits(RPCClient, EventEmitter);
/** server - client **/
function RPCClient(socket, delegate) {
    EventEmitter.call(this);
    this.socket = socket;
    this.socket.endpoint = this;
    this.delegate = delegate;
    this.queue    = [];
    this.sendWait = 20;
    this.waitBulk = false;
    this.sendTime = undefined;
    this.isReady = false;
    this.protobuf = false;
    this.setup();

    Object.defineProperty(this, "configure", {
        get:function () {
            return this.socket.configure;
        },
        enumerable: false,
        configurable: false,
    })
    Object.defineProperty(this, "sn", {
        get:function () {
            return this.socket.sn;
        },
        enumerable: false,
        configurable: false,
    })
}
RPCClient.prototype.setup = function () {
    var self = this;
    var socket = this.socket;
    socket.on("setup", self.handleSetup.bind(this));
    socket.on("message", self.handleMessage);
    socket.on("close", self.handleClosed.bind(this));
};
RPCClient.prototype.handleSetup = function (json) {
    // server setting
    this.protobuf = (json.protobuf == true && this.delegate.iProtobuf.enabled == true);
    NSLog.log("info", "Socket connection.", this.configure);
    if (json.protobuf) {
        this.socket.write(JSON.stringify({action:"onSetup", event:true, protobuf: this.protobuf}) + this.socket.delimiter);
    }
    this.isReady = true;
};
RPCClient.prototype.handleMessage = function (json) {
    const self = this.endpoint;
    if (self.protobuf) {
        self.handleMessageProtoBuf(json);
        return;
    } else if (self.configure.buf) {
        json = JSON.parse(json.toString())
        console.log(json);
    }

    var isArr = Array.isArray(json.batch);
    var arr;
    if (typeof this.configure == "undefined" && typeof this.configure.uuid == "undefined") {
        return;
    }
    if (isArr) {
        arr = json.batch;
        for (var i = 0; i < arr.length; i++) {
            json = arr[i];
            self.handle(json);
        }
    } else {
        self.handle(json);
    }
};
RPCClient.prototype.handleMessageProtoBuf = function (buf) {
    const root = this.delegate.iProtobuf.builder;
    const reqQueues = root.lookupType(ProtoBufEnums.rpcReqQueues);
    const reqMessage = root.lookupType(ProtoBufEnums.rpcReqMessage);
    const queue = reqQueues.decode(buf);
    const len = queue.len || queue.batch.length;
    var message;
    var paramsMessage;
    var decode;
    for (var i = 0; i < len; i++) {
        message = queue.batch[i];
        if (message.paramsType != null || typeof message.paramsType != "undefined") {
            message.params = this.decode(message.params, message.paramsType);
        }
        this.handle(reqMessage.toObject(message));
    }
};
RPCClient.prototype.handleClosed = function () {
    //close event
    this.isReady = false;
    this.socket.endpoint = undefined;
};
RPCClient.prototype.handle = function (json) {
    const self = this;
    var response = function (data, type) {
        if (typeof self.sendTime == "undefined" || (new Date().getTime() - self.sendTime) > 20) {
            self.send(data, type);
        } else {
            self.bulk(data, type);
        }
    };
    const callback = function (err, result) {
        var type = undefined;
        var respond = {
            id: json.id
        };

        if (self.protobuf) {
            //type = ProtoBufEnums.rpcResMessage;
            if (typeof result != "undefined" && typeof result.fileType != "undefined") {
                respond.result = self.encode(result, result.fileType);
                respond.fileType = result.fileType;
            }
            if (typeof err != "undefined" && typeof err.errorType != "undefined") {
                respond.error = self.encode(err, err.errorType);
                respond.errorType = err.errorType;
            }
        } else {
            if (err) {
                respond.error = err.toString();
            }
            respond.result = result;
        }
        response(respond, type);
        response = undefined;
    };

    this.delegate.handleCall(json, this, callback);

};
RPCClient.prototype.bulk = function (message, type) {
    if (this.protobuf) {
        if (typeof type == "undefined") {
            this.queue.push(message);
        } else {
            this.queue.push({
                type: type,
                payload: this.encode(message, type)
            });
        }
    } else {
        this.queue.push(message);
    }


    if (this.waitBulk == false) {
        var self = this;
        this.waitBulk = true;
        var time = setTimeout(function () {
            if (self.protobuf) {
                const payload = self.encode({
                    batch: self.queue,
                    len: self.queue.length
                }, ProtoBufEnums.rpcResQueues);
                self.send(payload);
            } else {
                self.send({batch:self.queue, len:self.queue.length});
            }
            // setImmediate(self.send.bind(this), {batch:self.queue});
            self.queue = [];
            self.waitBulk = false;
            clearTimeout(time);
            time = undefined;
            self = undefined;
        }, self.sendWait)

    }

};
/**
 *
 * @param [json.type]
 * @param type
 */
RPCClient.prototype.send = function (json, type) {
    const socket = this.socket;
    var payload;

    if (this.protobuf) {
        if (typeof json == "object" && !Buffer.isBuffer(json)) {
            var item;
            if (typeof type != "undefined") {
                item = {type: type, payload: this.encode(json, type)};
            } else {
                item = json;
            }
            payload = this.encode({
                batch: [item],
                len: 1
            }, ProtoBufEnums.rpcResQueues);
        } else {
            payload = Buffer.from(json);
        }
    } else {
        if (Buffer.isBuffer(json)) {
            payload = Buffer.from(json);
        } else if (typeof json == "object") {
            payload = JSON.stringify(json);
        } else {
            payload = json;
        }
    }
    if ((socket && socket.writable && !socket.destroyed)) {
        this.delegate.server.send(socket, payload);
        // setImmediate(socket.write.bind(socket), json + socket.delimiter);
        this.sendTime = new Date().getTime();
    } else {
        console.log('socket is destroyed.');
    }
};

RPCClient.prototype.encode = function (obj, type) {
    const instance = this.delegate.iProtobuf.builder.lookupType(type);
    const data = instance.fromObject(obj);
    const payload = instance.encode(data).finish();
    return payload;

};
RPCClient.prototype.decode = function (obj, type, options) {
    const instance = this.delegate.iProtobuf.builder.lookupType(type);
    const data = instance.decode(obj);
    if (typeof options == "undefined") return instance.toObject(data, options);
    return instance.toObject(data, {
        enums: String
    });
};

util.inherits(Client, EventEmitter);
/**
 *
 * @param delegate
 * @param {Object} [options]
 * @param {String} [options.host] address
 * @param {Number} [options.port] port
 * @param {Boolean} [options.ipc] ipc chancel
 * @param {String} [options.sockPath] ipc chancel path
 * @param {Boolean} [options.listen] listen socket port
 * @param {String} [option.delimiter] once data delimiter
 * @constructor
 */
function Client(delegate, options) {
    EventEmitter.call(this);
    if (typeof options == "undefined") {
        options = {host: "127.0.0.1", port:8797};
    }

    this.client    = this.setup(options);
    this.queue     = [];
    this.delegate  = delegate;
    this.callbacks = {};
    this.sendWait  = 20;
    this.waitBulk  = false;
    this.sendTime  = undefined;
    this.isReady   = false;
    this.iProtobuf = {
        builder: undefined,
        instances: {},
        enabled: false
    };
    const self = this;
    Object.defineProperties(this, {
        "isConnect": {
            get:function () { return self.client.isConnect; },
            enumerable:false,
            configurable:false
        },
        "__token": {
            value:0,
            writable:true,
            enumerable:false,
            configurable:false
        },
        "token": {
            get:function () {
                if (self.__token >= 1000000) {
                    self.__token = (self.__token % 1000000);
                }

                return (self.__token++).toString(32);
            },
            enumerable:false,
            configurable:false
        },
        "remoteAddress":{
            get:function () {
                return this.client.socket.remoteAddress;
            }
        }
    });
}
Client.prototype.setup = function (options) {
    NSLog.log("trace", "Starting connect programs from the RPC.", options);
    const optTyped = (typeof options != "undefined");
    const self = this;
    const sock = new NetSocket(options);
    sock.actSetup = {};
    sock.on("connect", function () {
        NSLog.log("info", "RPC %s:%s is Connection.[RPC.Connect] [ ON ]", options.host, options.port);
        var setup = sock.actSetup;
        if (typeof options != "undefined" && typeof options.setup == "object") {
            sock.actSetup = setup = options.setup;
        }
        if (typeof setup.uuid == "undefined") {
            setup.uuid = process.pid.toString(32) + "." + (parseInt(Math.random() * 0x10000)).toString(32) + (parseInt(Math.random() * 0x10000) + (SN_DF++)).toString(32);
        }
        setup.action = "setup";

        if (optTyped && typeof options.delimiter == "string") {
            setup.delimiter = options.delimiter;
        }
        if (optTyped && typeof options.namespace == "string") {
            setup.namespace = options.namespace;
        }
        if (optTyped && typeof options.typedef == "string") {
            setup.typedef = options.typedef;
        }
        if (optTyped) {
            setup.balance = options.balance;
            setup.cluID = setup.uuid;
        }
        sock.send(setup);
    });
    sock.on("message", function (msg) {
        // NSLog.log("debug",'msg:%s', JSON.stringify(msg, null, '\t'));

        if (msg.action == "onSetup") {
            self.isReady = true;
            NSLog.log("info","RPC.setup.isReady:%s [%s:%s]", self.isReady, options.host, options.port);
            if (msg.protobuf != true && self.iProtobuf.enabled == true) {
                self.iProtobuf.enabled = false;
                self.client.configure.protobuf = false;
            }
            self.emit("connect");
        } else if (sock.configure.typedef != "json" && self.isReady == false) {
            msg = JSON.parse(msg.toString());
            if (msg.action == "onSetup" && msg.event) {
                self.isReady = true;
                if (msg.protobuf != true && self.iProtobuf.protobuf == true) {
                    self.iProtobuf.enabled = false;
                    self.client.configure.protobuf = false;
                }
                self.emit("connect");
            }
        } else {
            if (self.iProtobuf.enabled) {
                self.protobufBatchHandle(msg);
            } else {
                if (Buffer.isBuffer(msg)) {
                    self.batchHandle(JSON.parse(msg.toString()));
                }
                else {
                    self.batchHandle(msg);
                }

            }
        }
    });
    sock.on("failure", function (err) {
        NSLog.log("info", "RPC.failure:%s %s:%s [ OFF ]", err.code, options.host, options.port);
        self.isReady = false;
    });
    sock.on("close", function () {
        self.isReady = false;
        self.emit("close");
    });
    sock.connect();
    return sock;
};
Client.prototype.initProtoBuf = function (file, callback) {
    const self = this;
    this.protoFile = file;
    ProtoBuf = require('../../PlayerCenter/node_modules/protobufjs');
    const root = ProtoBuf.loadSync(file);
    this.iProtobuf = {
        builder: root,
        instances: {},
        enabled: true
    }
    return root;
}
Client.prototype.batchHandle = function (json) {
    const self = this;
    var isArr = Array.isArray(json.batch);
    var arr;

    if (isArr) {
        arr = json.batch;
        for (var i = 0; i < arr.length; i++) {
            json = arr[i];
            self.handle(json);
        }
    } else {
        self.handle(json);
    }
};
Client.prototype.protobufBatchHandle = function (buf) {
    const self = this;
    const root = self.iProtobuf.builder;
    const queues = root.lookupType(ProtoBufEnums.rpcResQueues);
    const data = queues.decode(buf);
    const items = queues.fromObject(data);
    const len = items.len || items.batch.length;
    var msgBuf;
    var packet;
    var objType;
    var message, error;
    var rpcResType, rpcResMsg;
    var fileType, result;
    var fileTypeEmpty;
    var errorTypeEmpty;
    for (var i = 0; i < len; i++) {
        packet = items.batch[i];
        fileTypeEmpty = (packet.fileType != "");
        errorTypeEmpty = (packet.errorType != "");
        if (fileTypeEmpty || errorTypeEmpty) {
            if (fileTypeEmpty) {
                message = this.decode(packet.result, packet.fileType);
            }
            if (errorTypeEmpty) {
                error = this.decode(packet.error, packet.errorType);
            }
            this.handle({
                id: packet.id,
                result: message,
                error: error
            });
        } else {
            message = this.decode(packet.payload, packet.type);
            this.handle(message);
        }
    }

};
Client.prototype.handle = function (msg) {
    if (msg.action == "onSetup") {
        this.isReady = true;
        NSLog.log("info","RPC.setup.isReady:%s", this.isReady);
        this.emit("connect");
    }
    else if (typeof this.callbacks[msg.id] != "undefined") {
        this.callbacks[msg.id](msg.error, msg.result);
        this.callbacks[msg.id] = undefined;
        delete this.callbacks[msg.id];
    } else if (typeof msg.action != "undefined" && this.delegate[msg.action] instanceof Function) {
        // broadcast
        this.delegate[msg.action](msg);
    }
};
/**
 * send one request for server
 * @param {string} method
 * @param {object} params
 * @param {function} cb
 */
Client.prototype.call = function (method, params, cb) {
    const type = params.paramsType;
    var message;
    if (params instanceof Function) {
        cb = params;
        params = null;
    }
    message = {
        method:method,
        params:params,
        id:this.token
    };
    if (typeof cb == "function") {
        this.callbacks[message.id] = cb;
    }
    if (this.iProtobuf.enabled) {
        if (typeof params == "object") message.params = this.encode(type, params);
        message = this.encode("Ctrl.Game.ReqMessage", message);
        const payload = this.encode("Ctrl.Game.ReqQueues", {batch: [message], len: 1});
        this.send(payload);
    } else {
        this.send(message);
    }

};
Client.prototype.bulk = function (method, params, cb) {

    var message = {
        method:method,
        params:params,
        id:this.token
    };

    if (typeof cb == "function") {
        this.callbacks[message.id] = cb;
    }
    if (this.iProtobuf.enabled) {
        if (Buffer.isBuffer(params)) {

        } else if (typeof params == "object") {
            const type = params.paramsType || "Empty";
            message.params = this.encode(params, type);
            message.paramsType = type;
        }
        this.queue.push(message);
    } else {
        this.queue.push(message);
    }

    if (this.waitBulk == false) {
        var self = this;
        this.waitBulk = true;
        var ts = new Date().getTime();
        function onBatching() {
            console.log('this.waitBulk', new Date().getTime() - ts);

            if (self.iProtobuf.enabled) {
                const payload = self.createProtoBufQueue();
                self.send(payload);
            } else {
                self.send({batch: self.queue, len: self.queue.length});
            }
            self.queue = [];
            self.waitBulk = false;
            clearTimeout(time);
            time = undefined;
            self = undefined;

        }
        var time = setTimeout(onBatching, self.sendWait);

    } else {

    }

};
Client.prototype.send = function (message) {
    const self = this;
    var json;
    const socket = this.client.socket;

    if (Buffer.isBuffer(message)) {
        json = Buffer.from(message);
    } else if (typeof message == "object") {
        json = JSON.stringify(message);
    } else {
        json = message;
    }
    if ((socket && socket.writable && !socket.destroyed && !this.client.destroyed) && this.isReady) {
        self.client.send(message);
        self.sendTime = new Date().getTime();
    } else {
        //this.queue.push(json);
    }
};

Client.prototype.updateQueue = function (cb) {

    this.client.send({batch:this.queue, len:this.queue.length});
    this.queue = [];
    if (cb) cb();
};

Client.prototype.encode = function (obj, type) {
    const instance = this.iProtobuf.builder.lookupType(type);

    const data = instance.fromObject(obj);

    const payload = instance.encode(data).finish();

    return payload;
};
Client.prototype.decode = function (buf, type, options) {
    const instance = this.iProtobuf.builder.lookupType(type);
    const data = instance.decode(buf);
    if (typeof options != "undefined") return instance.toObject(data, options);
    return instance.toObject(data, {
        enums: String
    });
};
Client.prototype.createProtoBufQueue = function () {
    const instance = this.iProtobuf.builder.lookupType(ProtoBufEnums.rpcReqQueues);
    const data = instance.fromObject({
        batch: this.queue,
        len: this.queue.length
    });
    const payload = instance.encode(data).finish();
    return payload;
}

Client.prototype.close = function () {
    this.client.close();
};


module.exports = exports = {Server:Server, Client:Client};



