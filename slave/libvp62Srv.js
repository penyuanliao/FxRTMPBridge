/**
 * Created by Benson.Liao on 16/3/9.
 */
/**
 * Created by Benson.Liao on 15/12/9.
 * --always-compact: always full gc().
 * --expose-gc: manual gc().
 */

const debug = require('debug')('rtmp:BridgeSrv');
debug.log = console.log.bind(console); //file log 需要下這行
const fxNetSocket = require('fxNetSocket');

const net = require('net');
const util = require('util');
const path = require('path');
const FxConnection = fxNetSocket.netConnection;
const parser = fxNetSocket.parser;
const utilities = fxNetSocket.utilities;
const libRtmp   = require('../fxNodeRtmp').RTMP;
const config    = require('../config.js');
const netStream  = require('./libvp62Cl.js');
const isWorker  = false;//('NODE_CDID' in process.env);
const isMaster  = (isWorker === false);

util.inherits(libvp62Srv,fxNetSocket.clusterConstructor);

function libvp62Srv() {

    /* Variables */

    this.connections = []; //記錄連線物件

    /* rtmp config - Variables */
    this.rtmpConnectListener = false; //send request "connect" event to be received data.

    this.init();
    console.log(config.srvOptions.port);
    this.srv = this.initWebSocketSrv(config.srvOptions.port);
};


libvp62Srv.prototype.init = function () {
    this.initProcessEvent();
};
/**
 * 建立NodeJS Server
 * @param port
 * @returns {port}
 */
libvp62Srv.prototype.initWebSocketSrv = function (port) {
    var self = this;
    var server = new FxConnection(port,{runListen: isMaster});

    server.on('connection', function (client) {

        debug('Connection Clients name:%s (namespace %s)',client.name, client.namespace);
        if(client.namespace.indexOf("policy-file-request") != -1 ) {
            console.log('Clients is none rtmp... to destroy.');
            client.close();
            return;
        }
        // self.setupFMSClient(client);
        var s = client.stream = new netStream();
        client.stream.on('onVideoData', function (data) {
            client.write(JSON.stringify({"len":data.length, "data":data}));
            // s.rtmp.socket.destroy();
        });

    });

    server.on('message', function (evt) {
        debug('message :', evt.data);
        var socket = evt.client;
        const sockName = socket.name;
        var data = evt.data;
        if (data.charCodeAt(0) == 123) {
            //object
            var json = JSON.parse(data);
            var event = json["event"];
            var _fms = self.connections[sockName].fms;
            //檢查fms有沒有被建立成功沒有就回傳失敗
            if (!_fms) {
                socket.write(JSON.stringify({"NetStatusEvent":"Connect.FMS.Failed"}));
                return;
            }

            /* ----------------------------------
             *        這邊是Websocket事件
             * ---------------------------------- */

            if (event == "Connect") {
                console.log('data', json["data"]);

            }else if (event == "close") {
                socket.close();

            }else if (event == "Send") {
                //測試用
                console.log('data', json["data"]);

                _fms.fmsCall("setObj",json["data"]);

            }else if (typeof event != 'undefined' && event != null && event != ""){

                _fms.fmsCall(event,json["data"]);

            } else {
                // todo call data
                console.log('[JSON DATA]', json);
                _fms.fmsCall( "serverHandlerAMF", json);
            };
        }else
        {
            /* 如果送出來了事件是字串的話會在這裡 */
        }

    });

    /** server client socket destroy **/
    server.on('disconnect', function (name) {
        debug('disconnect_fxconnect_client.');

        var removeItem = self.connections[name];

        if (typeof removeItem != 'undefined' && typeof removeItem.fms != 'undefined' && removeItem.fms) {

            removeItem.fms.socket.destroy();
            delete self.connections[name];

            console.log('disconnect count:', Object.keys(self.connections).length,typeof removeItem != 'undefined' , typeof removeItem.fms != 'undefined' );
        };

    });

    /**
     * client socket connection is http connect()
     * @param req: request
     * @param client: client socket
     * @param head: req header
     * **/
    server.on('httpUpgrade', function (req, client, head) {

        debug('## HTTP upgrade ##');
        var _get = head[0].split(" ");

        var socket = client.socket;
        failureHeader(404, socket, "html");
        client.close();

    });
    /**
     * @param code: response header Status Code
     * @param socket: client socket
     * */
    function failureHeader(code, socket) {

        var headers = parser.headers.responseHeader(code, {
            "Connection": "close" });
        socket.write(headers);

    };

    return server;
};


module.exports = exports = libvp62Srv;


var service = new libvp62Srv();

