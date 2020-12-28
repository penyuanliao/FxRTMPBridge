/**
 * Created by Benson.Liao on 2016/11/17.
 * @module NetAMF
 */
const mCrypto        = require('crypto');
const net            = require('net');
const util           = require('util');
const events         = require('events');
const amf3Utils      = require('./amf3Utils.js');
const log            = require('./log.js');
const amfUtils       = require('./amfUtils.js');
const responder      = require('./responder.js');
const objectType     = require('./ObjectType.js');
/** html flag **/
const CRLF            = "\r\n";
/** AMF flag **/
const AMF3_DICTIONARY = 0x11;
/** connect Flash version **/
const FLASH_VERSION   = "17,0,0,160";
const SWF             = "Adobe Flash Player 17";
const retries_maximum = 1;

// const SWF = "Shockwave Flash";
/** keep alive count **/
const ApacheMaxKeepAliveRequests = 100;

var NSLog  = ifdef('../../FxLogger.js','fxNetSocket');
var debugEnabled = true;

util.inherits(NetAMF, events.EventEmitter); // 繼承事件
util.inherits(NetServices, events.EventEmitter); // 繼承事件
/**
 * AMFPHP NetConnection
 * @constructor NetAMF
 */
function NetAMF() {
    events.EventEmitter.call(this);

    this.uptime = new Date().getTime().toString();
    this.AMFVersion = 3; //0:AMF0, 3:AMF3
    this.Header_Count = 0;
    this.Message_Count = 0;
    this.responders = {}; // dispatch Event
    this.response_count = 0;
    this.amf3Serializer = new amf3Utils.serializer();
    this.amf3Deserializer = new amf3Utils.deserializer();

    this.END_FIN     = false;

    this.content_header = Buffer.alloc(6);

    this._client = undefined;

    this.socket     = undefined; // connect socket
    /**
     * socket connect options
     * @type {{port: number, host: string}}
     */
    this.socket_options = {port:1935, host:'localhost', allowHalfOpen:true};
    this._keepAlive = true;
    this.__running = false; // queue running
    this.callQueue = [];
    this.tokenList    = []; // send all reqKey
    this.keepAliveCount = 0;
    this.keepAliveMax = 100;
    /**
     * request header key & value
     * @type {Array}
     */
    this.headers = [];


    this.waitToSend = false;
    this.messages   = undefined; // one tick message


    this.setup();
}
/**
 * initial setup variable
 */
NetAMF.prototype.setup = function () {
    this.objectEncoding = 3;

    this.headers["POST"] = "/amfphp/gateway.php";
    this.headers["x-flash-version"] = FLASH_VERSION;
    this.headers["Content-Type"] = "application/x-amf";
    this.headers["Content-Length"] = 0;
    this.headers["User-Agent"] = SWF; //"Shockwave Flash";
    this.headers["Host"] = "127.0.0.1"; //socket.remoteAddress
    this.headers["Cache-Control"] = "no-cache"; //socket.remoteAddress
    this.headers["Cookie"] = "PHPSESSID=" + mCrypto.createHash("md5").update(this.uptime).digest("hex");

    this.__initialize();

};
/**
 * initial process
 * @private
 */
NetAMF.prototype.__initialize = function () {
    var self = this;

    if (this.socket || typeof this.socket != "undefined") {
        this.socket.removeAllListeners();
        this.socket.destroy();
        this.socket = undefined;
    }
    var runMax;
    var socket = this.socket = new net.Socket();
    this.socket.setMaxListeners(0);
    // this.socket.setTimeout(3*1000);
    this.socket.nbufs;
    socket.on("connect", function () {
        debug("[Event:'connect']Socket connection is successfully.");
        self.emit('connect');
        socket.setKeepAlive(self._keepAlive,5);
        socket.setTimeout(10 * 1000);
    });
    socket.on("data", function (chunk) {
        // pending data
        if (typeof socket.nbufs == "undefined") {
            socket.nbufs = chunk;
        }else {

            if (self.readResHeaders(chunk)['general'] != null && socket.nbufs.length > 0) {
                console.log(self.readResHeaders(chunk)['general']);

                self.deserialize(chunk);

                return;
            } else {
                socket.nbufs = Buffer.concat([socket.nbufs, chunk], socket.nbufs.length + chunk.length);
            }
        }
        if (self._keepAlive) {
            runMax = 30;
            while (socket.nbufs.length > 0 || runMax-- > 0) {
                if (self.deserialize() == false) return;
            }
        }
    });
    socket.on("end", function () {
        debug("[Event:'End']Socket sends a FIN packet.");
        if (!self._keepAlive) {
            self.deserialize();
        }
        self.END_FIN = true;
        self.cleanTokenList();
    });
    socket.on("error", function (error) {
        debug(util.format("[Event:'Error']Socket error:%s", error));
        socket.destroy();
        self.END_FIN = true;
        self.emit("error", error);
    });
    socket.on("timeout", function () {
        debug("[Event:'Timeout']Socket is timeout.");
        socket.destroy();
        self.END_FIN = true;
        self.emit("timeout");
    });
    socket.on("close", function () {
        debug("[Event:'Close']Socket is close");
        if (socket.nbufs.length >= 0 && self.END_FIN == false) {
            self.END_FIN = true;
            socket.nbufs = undefined;
        }
        self.emit("close");
        self.__restartQueue();
    });

};
/**
 * system error event
 * @param error
 */
NetAMF.prototype.error = function (error) {
    console.log(error);
};
/**
 * socket connect
 * @param uri {string}
 */
NetAMF.prototype.connect = function (uri) {
    //URL argument
    this.__setsockopt(uri);
    console.log('** start connect AMFPHP **');
    this.socket.connect(this.socket_options);
};
/**
 * @typedef {Object} callArguments
 * @property {string} command
 * @property {function} responder
 * @property {String|Number|Object|*} ...arguments
 */
/**
 * Calls a command or method on AMFPHP
 * @param command {String} [name]
 * @param responder {object|{onResult:function, onStatus:function} | null}
 * @param arguments {...*} [value]
 * @return string {String}
 * @description ...args data
 */
NetAMF.prototype.call = function (command, responder /* args */) {
    var self = this;

    var args = Array.prototype.slice.call(arguments);
    command = args.shift(); // remove command name
    if ((typeof responder != "undefined" && responder != null && typeof responder.onResult == "function" && typeof responder.onStatus== "function") || arguments[1] == null) {
        args.shift(); // remove responder
    } else if (typeof responder == "number") {
    args.shift(); // remove responder
    } else {
        responder = undefined;
    }
    /* set AMF Message Header */
    this.content_header.writeUInt16BE(this.Header_Count, 2);// header count

    this.content_header.writeUInt16BE(++this.Message_Count, 4);// message count

    var message = this.encodeMessage.apply(this,args);
    var targetURI = this.encodeTargetURI(command);
    var reqKey = "/";
    var responseURI;
    var messageLength = Buffer.alloc(4);
    messageLength.writeUInt32BE(message.length, 0);
    // console.log("Responder type:",typeof responder != "undefined" , responder != null);
    if (typeof responder == "number") {

        reqKey = "/"+responder;

    } else if (typeof responder != "undefined" && responder != null) {

        reqKey += (++this.response_count);
        this.responders[reqKey] = {selector:responder, command:command};
    }
    responseURI = this.amf3Serializer.encodeDynamic(reqKey); // amf3 string
    this.addTokenList(reqKey);
    debug(util.format('arguments {responseURI:%s\n\t command:%s \n\t arguments:%s}', responseURI, command, JSON.stringify(args)));
    var len = targetURI.length + responseURI.length + messageLength.length + message.length;

    if (typeof this.messages == "undefined")
        this.messages = Buffer.concat([targetURI, responseURI, messageLength, message], len);
    else{

        this.messages = Buffer.concat([this.messages, targetURI, responseURI, messageLength, message],this.messages.length + len);
    }

    if (typeof this.waitToSend != "undefined" && this.waitToSend == true) return reqKey;

    this.waitToSend = true; // Use pending to be done.

    setTimeout(function () {

        if (self.socket && self.connected) {
            self.__outgoingMessage();

        } else if (self.END_FIN == true) {
            self.END_FIN = false;
            self.socket.destroy();
            //if (self.END_FIN == true) { }

            // if (self.doConnect == true) return;

            self.socket.connect(self.socket_options, function () {
                self.__outgoingMessage();
            });
        } else {
            setTimeout(function () {
                self.waitEedFIN();
            },10);
        }

    },0);

    return reqKey;
};

NetAMF.prototype.addTokenList = function (reqKey) {
    this.tokenList[reqKey] = this.keepAliveCount;
    if (typeof this.tokenGroup == "undefined") this.tokenGroup = {};
    if (typeof this.tokenGroup[this.keepAliveCount] == "undefined") this.tokenGroup[this.keepAliveCount] = [];
    this.tokenGroup[this.keepAliveCount].push(reqKey);
};
NetAMF.prototype.removeTokenList = function (resKey) {
    delete this.tokenList[resKey];
};
NetAMF.prototype.getTokenList = function (resKey) {

    var group = this.tokenList[resKey];
    var tokens = this.tokenGroup[group];
    return tokens;
};
NetAMF.prototype.getFirstTokenList = function () {

    var keys = Object.keys(this.tokenList);
    var first = -1;
    for (var i = 0; i < keys.length; i++) {
        var index = this.tokenList[keys[i]];
        if (first == -1) {
            first = index;
        } else {
            first = Math.min(parseInt(index), parseInt(first));
        }

    }
    var list = this.tokenGroup[first.toString()];
    if (typeof list == "undefined") {
        return [];
    }else {
        return list;
    }

};
NetAMF.prototype.cleanTokenList = function () {
    this.tokenList  = [];
    this.tokenGroup = {};
    this.keepAliveCount = 0;

};

NetAMF.prototype.waitEedFIN = function () {
    var self = this;
    if (this.END_FIN == false) {
        setTimeout(function () {
            self.waitEedFIN();
        },10);
    } else {
        this.END_FIN = false;
        this.socket.destroy();
        this.socket.connect(self.socket_options, function () {
            self.__outgoingMessage();
        });
    }
};
/**
 * @private __outgoingMessage
 * @returns {Buffer}
 */
NetAMF.prototype.__outgoingMessage = function () {
    var self = this;
    // console.log('do Buffer.concat', self.messages.length);
    var msg_len = self.messages.length;
    var data = self.messages.slice(0,msg_len);
    self.messages = self.messages.slice(msg_len,self.messages.length);
    /* Sets a single header value */
    self.setHeader("Content-Length", msg_len + self.content_header.length);

    var rawHeaders = Buffer.from(self.getHeaders());

    var request = Buffer.concat([rawHeaders, self.content_header, data], rawHeaders.length + self.content_header.length + msg_len);

    if (self._keepAlive == false) {
        self.__addQueue(request);
        if (!this.__running) {
            this.__startQueue();
        }
    } else {
        ++self.keepAliveCount;
        if (this.keepAliveMax-2 > 0) {
            self.socket.write(request);
        }else {
            self.socket.end(request);
        }

    }


    self.Message_Count = 0;
    self.waitToSend = false;
};
/**
 * encode target Url value length(2B)|value
 * @param str
 * @returns {Buffer}
 */
NetAMF.prototype.encodeTargetURI = function(str) {
    var buf = Buffer.alloc(2 + str.length);

    buf.writeUInt16BE(str.length, 0);

    buf.write(str, 2);

    return buf;
};

/**
 * Action Message Format
 * AMF version: 3
 * Header count: 0
 * Message count: 1
 * Message
 *   Target URI: Dealer.ping2 <- argument[0]
 *   Response URI: /1
 *   Length: 24
 *   Strict array:
 *     AMF0 type: Strict array (0x0a)
 *     Array Length: 2
 *     Number 1 <- argument[1]
 *     Switch to AMF3
 *   Object <- argument[2]
 *   @param arguments {*}
 *   @return merge{buffer}
 */
NetAMF.prototype.encodeMessage = function () {
    var i, merge;
    var strictArray = [];
    var arrayLength = arguments.length;
    var amf0encode = undefined;
    var tmp = undefined;
    var body = undefined;
    if (this.AMFVersion == this.ObjectEncoding.AMF0) {
        for (i = 0; i < arguments.length; i++) {
            var arg = arguments[i];
            strictArray.push(arg);
        }
        merge = amfUtils.amf0encSArray(strictArray);
    }else {
        merge = amfUtils.amf0encSArray(strictArray); // Strict array header
        merge.writeUInt32BE(arrayLength, 1); // set Array Length

        if (arguments.length == 0) return merge; //

        var flag;
        var switch2amf3 = false;
        var value;
        var dictionary = Array.prototype.slice.call(arguments);
        var totalsize = 0;
        var lists = [];
        while (dictionary.length > 0)
        {
            value = dictionary[0];
            flag = (typeof value == "number") || (typeof value == "string");
            // isNumber or isString
            if (flag && switch2amf3) {

                tmp = amfUtils.amf0EncodeOne(value);

                if (typeof amf0encode == "undefined") {
                    amf0encode = tmp;
                }else {
                    amf0encode = Buffer.concat([amf0encode, tmp], amf0encode.length + tmp.length);
                }
                dictionary.shift();
            }else {
                switch2amf3 = true;
                // console.log('dictionary:', dictionary.length);
                body = this.amf3Serializer.amf3Encode(dictionary, AMF3_DICTIONARY);
                dictionary.length = 0;
            }
        }
        lists.push(merge);
        totalsize += merge.length;

        if (typeof amf0encode != "undefined") {
            lists.push(amf0encode);
            totalsize += amf0encode.length;
        }
        if (typeof body != "undefined") {
            lists.push(body);
            totalsize += body.length;
        }

        merge = Buffer.concat(lists, totalsize);
    }

    return merge;
};
NetAMF.prototype.__validateURLString = function (uri) {
    return uri.match(/^(rtmp|http)?:\/\/?([\w.]+):?([0-9]+)?([\/\w\._]+)/i);
};
/**
 *
 * @param uri {string}
 * @private
 */
NetAMF.prototype.__setsockopt = function (uri) {

    var val_args = this.__validateURLString(uri);

    this.setHeader("POST", val_args[4]);

    if (typeof val_args[2] != "undefined") {
        this.socket_options["host"] = val_args[2];
        this.setHeader("Host", val_args[2]);
    }

    if (typeof val_args[3] != "undefined") {
        this.socket_options["port"] = parseInt(val_args[3]);
    }else {
        this.socket_options["port"] = 80;
    }
};
// ------------------ //
//   response event   //
// ------------------ //
/**
 * @private
 * @return boolean
 */
NetAMF.prototype.deserialize = function (buf) {
    var socket = this.socket;
    var nbufs = socket.nbufs;
    var isOnce = (typeof buf != "undefined" && buf != null);
    var self = this;
    if (isOnce) {
        nbufs = buf;
    }
    var offset = nbufs.indexOf((CRLF+CRLF));
    var second;
    var contentLength;
    var content;
    // console.log('deserialize Header offset:',offset);
    if (offset == -1) return false;

    var cResHeaders = this.readResHeaders(nbufs.slice(0, offset)); // read the binary header
    offset += 4;

    // console.log('resHeaders:', cResHeaders);
    var status = cResHeaders["general"][2];
    contentLength = parseInt(cResHeaders["content-length"]);
    var keepAliveMax = cResHeaders["keep-alive"];
   NSLog.log("error", "keepAliveMax ",keepAliveMax , this.keepAliveMax);
    if (typeof keepAliveMax != "undefined") {
        this.keepAliveMax = Math.max(parseInt(keepAliveMax.substr(keepAliveMax.search("max=")+4, keepAliveMax.length)), this.keepAliveMax);
    }else{
        //this.keepAliveMax = 100;
    }
    if (cResHeaders["connection"] == 'close') socket.writable = false;

    if (isNaN(contentLength) == true) {
        second = offset;
        if (second != -1 )
            contentLength = nbufs.length - offset;
        else
            contentLength = nbufs.length;
    }

    if ((contentLength + offset) > nbufs.length) return false;

    content = nbufs.slice(offset, offset+contentLength);

    if (status == 200) {
        // console.log('1.deserialize Content-Length:', contentLength);
        if (!isOnce) socket.nbufs = nbufs.slice(offset+contentLength, nbufs.length);
        // console.log("2.deserialize buffer.length ", socket.nbufs.length);
        // read the binary body
        if (content[0] == 0x00) {

            var AMFObject = this.readBody(content);
            this.__executionAction(AMFObject);

        }else {
            //fault event
            this.readFaultData(content);
        }

    } else {
        NSLog.log("error",'Status:%s, faultDetail:%s', status, content.toString());

        if (!isOnce) socket.nbufs = nbufs.slice(offset+contentLength, nbufs.length);

        self.emit("retry", status);

        return false;
    }
    content = undefined;

    return true;
};

NetAMF.prototype.setHeader = function (name, value) {
    // name = name.toUpperCase();
    if (typeof name == "undefined" || !name || name === null) {
        console.error('The "name" variable is undefined');
    }
    if (typeof value == "undefined" || !value || value === null) {
        console.error('The "value" variable is undefined');
    }
    this.headers[name] = value;
};
/**
 * get final HTTP Hypertext
 * @param options final last custom set header
 * @returns {string}
 */
NetAMF.prototype.getHeaders = function (options) {

    if (typeof options == 'object' && options.constructor == Object) {
        var keys = Object.keys(options);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            this.setHeader(key, options[key]);
        }
    }

    var resHeaders = [
        'POST ' + this.headers["POST"] + ' HTTP/1.1',
        'Host: ' + this.headers["Host"],
        'User-Agent: ' + this.headers["User-Agent"],
        'x-flash-version: ' + this.headers["x-flash-version"],
        'Content-Type: ' + this.headers["Content-Type"],
        'Content-Length: ' + this.headers["Content-Length"],
        'Cache-Control: ' + this.headers["Cache-Control"],
        'Cookie: ' + this.headers["Cookie"]
        // 'Connection: ' + "Upgrade"
    ];

    if (this._keepAlive) {
        resHeaders.push('Connection: ' + "Keep-Alive");
    }else {
        resHeaders.push('Connection: ' + "close");
    }


    return resHeaders.join(CRLF) + CRLF + CRLF;
};
/**
 * read response data
 * @param chunk {Buffer}
 * @returns {*}
 */
NetAMF.prototype.readResHeaders = function (chunk) {

    /* Variables */
    var data = chunk.toString('utf8');
    var lines = data.split(CRLF);
    var headers = {};
    var i = lines.length;

    if (lines.length === 1) return false;

    // headers["source"] = data;
    // headers["lines"] = lines;
    //Check is HTTP/1.1 200 OK
    headers['general'] = lines[0].toString().match(/^(HTTP\/[0-9\.]+) ([0-9]+) ([\w '\\\/.]+)/i);

    if (lines == null) return false;

    while(--i > 0) {

        if (lines[i] === null || lines[i] === '') continue;

        var match = lines[i].toString().match(/^([a-z-A-Z0-9]+): (.+)/i);

        if (match === null) continue;

        headers[match[1].toLowerCase()] = match[2];
    }
    return headers;
};
/**
 * read AMF content
 * @param buf
 * @returns {{amf_version: (Number|*), headerCount: (Number|*), headers: Array, messageCount: (Number|*), messages: Array}|*}
 */
NetAMF.prototype.readBody = function (buf) {
    var decodeFlags;
    // var decodeTime = new Date().getTime();
    var amf_version, headerCount, headersNameLen, headerName, MustUnderstand;
    var count,len, obj;
    var messageCount, targetURI, responseURI;
    var headers = [];
    var message = [];
    var AMFObject;
    var offset = 0;
    amf_version = buf.readUInt16BE(offset);
    offset+=2;
    headerCount = buf.readUInt16BE(offset);
    offset+=2;
    count = headerCount;
    while (count > 0) {
        headersNameLen = buf.readUInt16BE(offset);
        offset+=2;
        headerName = buf.slice(offset, offset+headersNameLen).toString();
        offset+=headersNameLen;
        MustUnderstand = buf.readUInt8(offset);
        offset++;
        len = buf.readUInt32BE(offset);
        offset+=4;
        obj = amfUtils.amf0decString(buf.slice(offset, offset + len));
        offset+=len;

        headers.push({
            name:headerName,
            mustUnderstand:(MustUnderstand == 1),
            len:len,
            value: obj["value"]
        });
        count--;
    }

    messageCount = buf.readUInt16BE(offset);
    offset+=2;
    count = messageCount;
    while (count > 0) {
        // log.logHex(buf.slice(offset-1, buf.length));
        targetURI = this.__decodeMessageOne(buf, offset);
        offset += targetURI.len;
        responseURI = this.__decodeMessageOne(buf, offset);
        offset+=responseURI.len;
        len = buf.readUInt32BE(offset);
        offset+=4;
        decodeFlags = buf.readUInt8(offset);
        // Switch to AMF3
        if (decodeFlags == AMF3_DICTIONARY) {
            // offset += 1;
            var load = buf.slice(offset+1, offset+1 + len);
            obj = this.amf3Deserializer.amf3Decode(load);
            offset += len;
        } else {
            obj = amfUtils.amf0DecodeOne(buf.slice(offset, offset + len))["value"];
            offset += len;
        }

        message.push({
            target:targetURI["value"],
            response:responseURI["value"],
            len:len,
            decodeFlags:decodeFlags,
            value:obj
        });
        // console.log(message);
        count--;
    }

    AMFObject = {
        amf_version: amf_version,
        headerCount:headerCount,
        headers:headers,
        messageCount:messageCount,
        messages:message
    };

    return AMFObject;
};
/**
 * read content HTTP status error
 * @param buf
 */
NetAMF.prototype.readFaultData = function (buf) {
    var errorMessage = buf.toString();
    NSLog.log("error",'INVALID_AMF_MESSAGE ', errorMessage);
    this.emit('fault', { "event":"INVALID_AMF_MESSAGE", "description":"Invalid AMF message", "error": errorMessage});
    this.socket.destroy();
};
/**
 * @param {AMFObject} AMFObject
 * @private
 */
NetAMF.prototype.__executionAction = function (AMFObject) {
    var self = this;
    var message, target, messageCount;
    var responder,offset, key, remoteMessage;
    const msgCount = AMFObject["messageCount"];
    messageCount = -1;
    while (++messageCount < msgCount) {
        message = AMFObject["messages"][messageCount];
        target = message["target"];
        // amf3 message
        // console.log(message);
        offset = target.indexOf("/",1);
        key = target.slice(0, offset);

        this.removeTokenList(key);

        remoteMessage = target.slice(offset+1,target.length);
        if (debugEnabled) {
            debug(util.format("responder key:%s, remoteMessage:%s, value:%s", key, remoteMessage));
        }else {
            debug(util.format("responder key:%s, remoteMessage:%s", key, remoteMessage));
        }

        if (key != '/' && (typeof self.client != "undefined")) {
            responder = this.responders[key]["selector"];
            if (typeof responder[remoteMessage] != "undefined") {
                responder[remoteMessage](message["value"], key, this.responders[key]["command"]);
            }else {
                NSLog.log("error","__executionAction:", remoteMessage,message["value"], key);
            }

            // release object //
            this.responders[key]["selector"] = undefined;
            this.responders[key]["command"]  = undefined;
            responder = undefined;
            this.responders[key] = undefined;
            delete this.responders[key];
        }
        else if (key != '/' ) {
            responder = this.responders[key]["selector"];

            if (message["value"].constructor.name == 'ErrorMessage') {
                message["value"].headers = AMFObject.headers;
            }

            responder[remoteMessage](message["value"]);
            // release object //
            responder["selector"] = undefined;
            responder["command"]  = undefined;
            responder = undefined;
            this.responders[key] = undefined;
            delete this.responders[key];

        }
        else if (typeof self.client != "undefined") {
            var func = self.client[remoteMessage];
            if (typeof func == 'function') func(message["value"]);
        } else {
            self.emit(remoteMessage, message["value"]);
        }

    }

};
NetAMF.prototype.__decodeMessageOne = function (buf, offset) {
    var obj = {};
    obj.len = buf.readUInt16BE(offset) + 2;
    obj.value = buf.slice(offset + 2, offset + obj.len).toString();
    return obj;
};
/**
 *
 * @param req
 * @private
 */
NetAMF.prototype.__addQueue = function (req) {

    if (typeof this.callQueue == "undefined") this.callQueue = [];

    this.callQueue.push(req);
    console.log('this.callQueue.push', this.callQueue.length);
};
/**
 *
 * @private
 */
NetAMF.prototype.__startQueue = function () {

    var self = this;

    if (self.callQueue.length > 0) {
        this.__running = true;
    } else {
        this.__running = false;
        return;
    }

    if (this.connected)
    {
        self.socket.write(this.callQueue.shift());
    } else {
        self.socket.connect(this.socket_options, function () {
            self.socket.write(self.callQueue.shift());
        });
    }

};
/**
 * @private
 */
NetAMF.prototype.__restartQueue = function () {
    var self = this;
    if (!self._keepAlive) {
        self.__startQueue();
    }
};
NetAMF.prototype.createFailMessage = function (status, command) {
    var errMsg = new objectType.ErrorMessage();
    errMsg.faultCode = "Client.Error.MessageSend";
    errMsg.errorID = 0;
    errMsg.faultDetail = "Channel.Connect.Failed error NetConnection.Call.Failed: HTTP: Status " + status + " url: '" + command + "'";
    errMsg.faultString = "Send failed";
    errMsg.message = "faultCode:Client.Error.MessageSend faultString:'Send failed'";
    errMsg.description = "HTTP: Status "+ status;

    errMsg.rootCause = {
        "code":"Client.Error.MessageSend",
        "description":"HTTP: Failed",
        "details":"/amfphp/Gateway.php",
        "level":"error",
        "type":"channelFault"
    };
    return errMsg;
};
/**
 * leaving the one you need release
 */
NetAMF.prototype.release = function () {
    this._client = null;
    this.responders = null;
    this.amf3Serializer = null;
    this.amf3Deserializer = null;
    this.content_header = null;
    this.socket = undefined; // connect socket
    this.socket_options = null;
    this.callQueue = null;
};

NetAMF.prototype.__defineSetter__("objectEncoding", function (value) {
    this.AMFVersion = value;
    this.content_header.writeUInt16BE(this.AMFVersion, 0); // amf version
});
NetAMF.prototype.__defineSetter__("setKeepAlive", function (bool) {
    if (typeof bool === 'boolean') {
        this._keepAlive = bool;

    }
});
NetAMF.prototype.__defineGetter__("connected", function () {
    if (typeof this.socket == "undefined" ) {
        return false;
    } else {
        // console.log('writable:', this.socket.writable,  this.socket.destroyed);
        // return !(this.socket._connecting === true);
        return (this.socket && this.socket.writable && !this.socket.destroyed);
    }
});
/**
 * Indicates the object on which callback methods are invoked.
 * @param value {object}[*import need class object]
 */
NetAMF.prototype.__defineSetter__("client", function (value) {
    this._client = value;
    console.log('set Client');
});
NetAMF.prototype.__defineGetter__("client", function () {
    if (this._client != null && this._client != 0 && typeof this._client != "undefined") {
        return this._client;
    }else {
        return undefined;
    }
});
NetAMF.prototype.__defineSetter__("debugEnabled", function (bool) {
    if (typeof bool === "boolean") {
        debugEnabled = bool;
    }else {
        debugEnabled = false;
    }
});
/**
 * @type {{AMF0: number, AMF3: number}}
 */
NetAMF.prototype.ObjectEncoding = {
    AMF0: 0,
    AMF3: 3
};

/**
 *
 * @param uri
 * @constructor NetServices
 */
function NetServices(uri) {
    events.EventEmitter.call(this);
    /**
     * amfPHP connect object
     * @type {NetAMF}
     */
    this.AMFSocket = undefined;

    this.selectors = new responder(this.onResult, this.onStatus, this);

    this.__initialize(uri);

    this.delegate = undefined;
    this._command = undefined;

    this._tmpHand  = undefined;
    this._tmpHands = [];
    this.retry_operation = [];
}
NetServices.prototype.__initialize = function (uri) {
    var self = this;
    var retriesConn;
    this.AMFSocket = new NetAMF();
    this.AMFSocket.client = this;
    this.AMFSocket.connect(uri);
    this.AMFSocket.on("retry", function (status) {
        var resKeys = this.getFirstTokenList();
        var index = resKeys.length;
        while (index-- > 0) {
            var resKey = resKeys[index];
            var info = self._tmpHands[resKey];
            if (info["retries"] <= 0) {
                var command = info["args"][0];
                NSLog.log("error", '(%s)Retries 1 has status 500:%s', resKey, command);
                //self.onStatus(self.AMFSocket.createFailMessage(status, command),resKey, command);
                //this.removeTokenList(resKey);
                continue;
            }
            var args = Array.prototype.slice.call(info["args"]);
            //args[1] = parseInt(resKey.substr(1,resKey.length));
            info["retries"]--;
            //this.removeTokenList(resKey);
            // self.faultRetries(self.AMFSocket, args);
            //self.AMFSocket.call.apply(self.AMFSocket, args);
            NSLog.log("error", 'FaultCode:%s Status "%s" retries:%s', resKey, status ,args[0]);



        }
        //self.AMFSocket.emit("end");
    });

};
NetServices.prototype.faultRetries = function (retriesConn,args) {
    var self = this;
    // self.retry_operation.push(args);
    retriesConn.call.apply(retriesConn, args);
};
/***
 * call api
 * @param command {String}
 * @param self {Object} need Class Object
 */
NetServices.prototype.getService = function (command, self) {

    this._command = command;
    this.delegate = self;
    // var cmd_args = command.split(".");
    // var responder = cmd_args[(cmd_args.length-1)];
    // var selector = cmd_args[(cmd_args.length-1)] + "_onResult";
};
NetServices.prototype.setAMFService = function (/** ...args **/) {

    var args = Array.prototype.slice.call(arguments);
    args.unshift(this.selectors);
    args.unshift(this._command);
    var resKey = this.AMFSocket.call.apply(this.AMFSocket,args);
    this._tmpHands[resKey] = {"func":this._tmpHand, "delegate": this.delegate, "args":args, "retries": retries_maximum, "timeout":setWaitTimeout(resKey, this)};

    function setWaitTimeout(resKey,self) {
        var nServices = this;
        return setTimeout(function () {
            NSLog.log("error", "Waiting 10sec has Timeout.");
            var info;
            if (typeof self._tmpHands[resKey] == "undefined") return;
            info = self._tmpHands[resKey];
            var args = Array.prototype.slice.call(info["args"]);
            args[1] = parseInt(resKey.substr(1,resKey.length));
            self.AMFSocket.call.apply(self.AMFSocket, args);
        },5000)
    }


};
NetServices.prototype.__defineSetter__("tmpHand", function (name) {
    this._tmpHand = name;
});
NetServices.prototype.__defineSetter__("debugEnabled", function (bool) {
    if (typeof bool === "boolean") {
        debugEnabled = bool;
    }else {
        debugEnabled = false;
    }
});


NetServices.prototype.onResult = function (result, resKey, command) {
    // console.log("onResult",result, command);
    var context = this;


    var funName = this._tmpHands[resKey]["func"];
    var iDelegate = this._tmpHands[resKey]["delegate"];
    var hasTmpHand = (funName != "" && typeof funName != "undefined" && funName != null && funName != 0);
    if (!hasTmpHand) {
        funName = command.slice(command.lastIndexOf(".")+1, command.length);
    }
    // console.log("funName " , this.delegate[funName + "_Result"] );

    if (typeof iDelegate[funName + "_Result"] != "undefined") {
        iDelegate[funName + "_Result"](result, command);
    }else {
        if (typeof iDelegate[funName] != "undefined" ) iDelegate[funName + "_Result"](result, command);
        context.emit(funName + "_Result", result, command);
    }

    this._tmpHands[resKey]["func"] = null;
    this._tmpHands[resKey]["delegate"] = null;
    clearTimeout(this._tmpHands[resKey]["timeout"]);
    delete this._tmpHands[resKey];
};
NetServices.prototype.onStatus = function (fault, resKey, command) {
    // console.log("onFault ",fault, command);
    var context = this;
    var funName = this._tmpHands[resKey]["func"];
    var iDelegate = this._tmpHands[resKey]["delegate"];
    var hasTmpHand = (funName != "" && typeof funName != "undefined" && funName != null && funName != 0);
    if (!hasTmpHand) {
        funName = command.slice(command.lastIndexOf(".")+1, command.length);
    }
    if (typeof iDelegate[funName + "_Status"] != "undefined") {
        iDelegate[funName + "_Status"](fault, command);
    }else {
        if (typeof iDelegate["Status"] != "undefined" ) iDelegate["Status"](fault, command);
        context.emit(funName + "_Status", fault, command);
    }
    this._tmpHands[resKey]["func"] = null;
    this._tmpHands[resKey]["delegate"] = null;
    clearTimeout(this._tmpHands[resKey]["timeout"]);
    delete this._tmpHands[resKey];
};
NetServices.prototype.release = function () {
    this.delegate = null;
    this.AMFSocket.release();
    this.AMFSocket = null;
    this._tmpHands = null;

};
/**
 * A connect created by amfphp socket
 * @module createGatewayConnection
 * @param uri {String}
 * @returns {NetServices}
 */
function createGatewayConnection(uri) {
    return new NetServices(uri);
}

function ifdef(a,b) {
    var req;
    try {
        req = require(a).getInstance();
    } catch (e) {
        if (e.code !== 'MODULE_NOT_FOUND') {
            throw e;
        }
        req = require(b).logger;
        req = req.getInstance();
    }
    return req;
}
function debug(arg) {
    if (debugEnabled) {
        NSLog.log("error", arg);
    } else {
        // console.log(arg);
    }

}

/**
 * A object containing a AMFMessage
 * @typedef {object} AMFObject
 * @property {number} amf_version - The decode version
 * @property {number} headerCount -
 * @property {object} headers
 * @property {string} headers.name
 * @property {boolean} headers.mustUnderstandff
 * @property {number} headers.len
 * @property {object|string|number} headers.value
 * @property {number} messageCount
 * @property {object} messages
 * @property {string} messages.target
 * @property {string|null} messages.response
 * @property {number} messages.len
 * @property {object|string|number} messages.value
 */

module.exports = exports = {
    NetAMF:NetAMF,
    NetServices:NetServices,
    createGatewayConnection: createGatewayConnection
};

/*

 var gateway2 = AMFConnection.createGatewayConnection('http://localhost:80/amfphp/gateway.php');
 gateway2.objectEncoding = gateway2.ObjectEncoding.AMF0;
 gateway2.call('Dealer.ping2',r,[{'hi':1},{'hi':1}], 1.04);
 */