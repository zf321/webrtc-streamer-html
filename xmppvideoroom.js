var XMPPVideoRoom = (function() {

	
	/** 
	 * Interface with Jitsi Video Room and WebRTC-streamer API
	 * @constructor
	 * @param {string} xmppUrl - url of XMPP server
	 * @param {string} srvurl - url of WebRTC-streamer
	*/
	var XMPPVideoRoom = function XMPPVideoRoom (xmppUrl, srvurl) {	
		this.xmppUrl     = xmppUrl;
		this.handlers    = [];
		this.srvurl      = srvurl || location.protocol+"//"+window.location.hostname+":"+window.location.port;
		this.sessionList = {};
	};
		

	/** 
	* Ask to publish a stream from WebRTC-streamer in a XMPP Video Room user
	* @param {string} roomid - id of the XMPP Video Room to join
	* @param {string} url - WebRTC stream to publish
	* @param {string} name - name in Video Room
	*/
	XMPPVideoRoom.prototype.join = function(roomid, url, name) {
		var bind = this;

		var connection = new Strophe.Connection(location.protocol+ "//" + this.xmppUrl + "/http-bind");
		connection.addHandler(function(iq) { return this.OnJingle(connection, iq, url) }, 'urn:xmpp:jingle:1', 'iq', 'set', null, null);

//		connection.rawInput = function (data) { console.log('RECV: ' + data); };
//		connection.rawOutput = function (data) { console.log('SEND: ' + data); };

		connection.connect(this.xmppUrl, null, function(status) { bind.onConnect(connection, roomid, name, status); });
	}

	XMPPVideoRoom.prototype.onReceiveCandidate = function(connection, iq, candidateList) {
		console.log("============candidateList:" +  JSON.stringify(candidateList));
		var jingle = iq.querySelector("jingle");
		var sid = jingle.getAttribute("sid");

		candidateList.forEach(function (candidate) {
			var json = SDPUtil.parse_icecandidate(candidate.candidate);
			console.log("webrtc candidate==================" +  JSON.stringify(json));

			//TODO convert candidate from webrtc to jingle 
			var param = $iq({ type: "set",  from: iq.getAttribute("to"), to: iq.getAttribute("from") })
			var jingle = param.c('jingle', {xmlns: 'urn:xmpp:jingle:1'});
			jingle.attrs({ action: "transport-info",  sid });

			var id = connection.sendIQ(jingle, () => {
				console.log("============transport-info ok sid:" + sid);		
			},() => {
				console.log("############transport-info error sid:" + sid);
			});
		});	
	}

	XMPPVideoRoom.prototype.onCall = function(connection, iq, data) {
		console.log("webrtc answer========================" + data.sdp);		
		
		var jingle = iq.querySelector("jingle");
		var sid = jingle.getAttribute("sid");
				
		var sdp = new SDP(data.sdp);
		var iqAnswer = $iq({ type: "set",  from: iq.getAttribute("to"), to: iq.getAttribute("from") })
		var jingle = iqAnswer.c('jingle', {xmlns: 'urn:xmpp:jingle:1'});
		jingle.attrs({ action: "session-accept",  sid, responder:iq.getAttribute("to") });

		var jingleanswer = sdp.toJingle(jingle); 
		var id = connection.sendIQ(jingleanswer, () => {
			console.log("============session-accept ok sid:" + sid);
				
			var method = this.srvurl + "/api/getIceCandidate?peerid="+ sid;
			request("GET" , method).done( function (response) { 
					if (response.statusCode === 200) {
						this.onReceiveCandidate(connection, jingleanswer.node, JSON.parse(response.body));
					}
					else {
						this.onError(response.statusCode);
					}
				}
			);			
		},() => {
			console.log("############session-accept error sid:" + sid);
		});
	}
	
	XMPPVideoRoom.prototype.onError = function (error) {
		console.log("############onError:" + error)
	}
		
	XMPPVideoRoom.prototype.OnJingle = function(connection, iq, url) {
		console.log("OnJingle from:" + iq.getAttribute("from") + " to:" + iq.getAttribute("to") + " action:" +  iq.querySelector("jingle").getAttribute("action"));
		var jingle = iq.querySelector("jingle");
		var sid = jingle.getAttribute("sid");
		var action = jingle.getAttribute("action");

		if (action === "session-initiate") {	
			var sdp = new SDP('');
			sdp.fromJingle($(jingle));

			console.log("xmpp offer============sdp:" + sdp.raw);
			var method = this.srvurl + "/api/call?peerid="+ sid +"&url="+encodeURIComponent(url)+"&options="+encodeURIComponent("rtptransport=tcp&timeout=60");
			request("POST" , method, {body:JSON.stringify({type:"offer",sdp:sdp.raw})}).done( function (response) { 
					if (response.statusCode === 200) {
						this.onCall(connection, iq, JSON.parse(response.body));
					}
					else {
						this.onError(response.statusCode);
					}
				}
			);
			this.sessionList[sid]=connection;
			
			var ack = $iq({ type: "result",  from: iq.getAttribute("to"), to: iq.getAttribute("from"), id:iq.getAttribute("id") })
			connection.sendIQ(ack);		

		} else if (action === "transport-info") {

			console.log("xmpp candidate============sid:" + sid);

			var contents = $(jingle).find('>content');
			contents.each( (contentIdx,content) => {
				var transports = $(content).find('>transport');
				transports.each( (idx,transport) => {
					var ufrag = transport.getAttribute('ufrag');
					var candidates = $(transport).find('>candidate');
					candidates.each ( (idx,candidate) => {
						var sdp = SDPUtil.candidateFromJingle(candidate);
						sdp = sdp.replace("a=candidate","candidate");
						sdp = sdp.replace("\r\n"," ufrag " + ufrag + "\r\n");
						var candidate = { candidate:sdp, sdpMid:"", sdpMLineIndex:contentIdx }
						console.log("send webrtc candidate============:" + JSON.stringify(candidate));
			
						var method = this.srvurl + "/api/addIceCandidate?peerid="+ sid;
						request("POST" , method, { body: JSON.stringify(candidate) }).done( function (response) { 
								if (response.statusCode === 200) {
									console.log("method:"+method+ " answer:" +response.body);
								}
								else {
									this.onError(response.statusCode);
								}
							}
						);							
					});
				});
			});
	
			var ack = $iq({ type: "result",  from: iq.getAttribute("to"), to: iq.getAttribute("from"), id:iq.getAttribute("id") })
			connection.sendIQ(ack);		
		}
					
		return true;		
	}
	
	XMPPVideoRoom.prototype.onConnect = function(connection, roomid, name, status)
	{		
	    if (status === Strophe.Status.CONNECTING) {
			console.log('Strophe is connecting.');
	    } else if (status === Strophe.Status.CONNFAIL) {
			console.log('Strophe failed to connect.');
	    } else if (status === Strophe.Status.DISCONNECTING) {
			console.log('Strophe is disconnecting.');
	    } else if (status === Strophe.Status.DISCONNECTED) {
			console.log('Strophe is disconnected.');
	    } else if (status === Strophe.Status.CONNECTED) {
			console.log('Strophe is connected.');
			
			// disco stuff
			if (connection.disco) {
				connection.disco.addIdentity('client', 'web');
				connection.disco.addFeature(Strophe.NS.DISCO_INFO);
				connection.disco.addFeature("urn:xmpp:jingle:1");
				connection.disco.addFeature("urn:xmpp:jingle:apps:rtp:1");
				connection.disco.addFeature("urn:xmpp:jingle:transports:ice-udp:1");
				connection.disco.addFeature("urn:xmpp:jingle:transports:raw-udp:1");
				connection.disco.addFeature("urn:xmpp:jingle:apps:dtls:0");
				connection.disco.addFeature("urn:xmpp:jingle:apps:rtp:audio");
				connection.disco.addFeature("urn:xmpp:jingle:apps:rtp:video");
				connection.disco.addFeature("urn:ietf:rfc:5761") // rtcp-mux
			}

			var roomUrl = roomid + "@" + "conference." + this.xmppUrl;
			var extPresence = Strophe.xmlElement('nick', {xmlns:'http://jabber.org/protocol/nick'}, name);
			connection.muc.join(roomUrl, name, null, null, null, null, null, extPresence);		
		}
	}
		
	XMPPVideoRoom.prototype.leave = function (roomid, userName) {
		Object.entries(this.sessionList).forEach( (sid,connection) => {
			var roomUrl = roomid + "@" + "conference." + this.xmppUrl;

			var param = $iq({ type: "set",  from: roomUrl +"/" + userName, to: roomUrl })
			var jingle = param.c('jingle', {xmlns: 'urn:xmpp:jingle:1'});
			jingle.attrs({ action: "session-terminate",  sid});
			connection.sendIQ(param);

			var method = this.srvurl + "/api/hangup?peerid="+ sid;
			request("GET" , method).done( function (response) { 
					if (response.statusCode === 200) {
						console.log("method:"+method+ " answer:" +response.body);
					}
					else {
						this.onError(response.statusCode);
					}
				}
			);					
			connection.muc.leave(roomUrl, userName);
			connection.flush();
			connection.disconnect();	
		});
		this.sessionList = {};
	}

	return XMPPVideoRoom;
})();

module.exports = XMPPVideoRoom;