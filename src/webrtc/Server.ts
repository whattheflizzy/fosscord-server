import { closeDatabase, Config, initDatabase, initEvent } from "@fosscord/util";
import dotenv from "dotenv";
import http from "http";
import ws from "ws";
import { Connection } from "./events/Connection";
dotenv.config();

export class Server {
	public ws: ws.Server;
	public port: number;
	public server: http.Server;
	public production: boolean;

	constructor({
		port,
		server,
		production,
	}: {
		port: number;
		server?: http.Server;
		production?: boolean;
	}) {
		this.port = port;
		this.production = production || false;

		if (server) this.server = server;
		else {
			this.server = http.createServer(function (req, res) {
				res.writeHead(200).end("Online");
			});
		}

		// this.server.on("upgrade", (request, socket, head) => {
		// 	if (!request.url?.includes("voice")) return;
		// 	this.ws.handleUpgrade(request, socket, head, (socket) => {
		// 		// @ts-ignore
		// 		socket.server = this;
		// 		this.ws.emit("connection", socket, request);
		// 	});
		// });

		this.ws = new ws.Server({
			maxPayload: 1024 * 1024 * 100,
			server: this.server,
		});
		this.ws.on("connection", Connection);
		this.ws.on("error", console.error);
	}

	async start(): Promise<void> {
		await initDatabase();
		await Config.init();
		await initEvent();
		if (!this.server.listening) {
			this.server.listen(this.port);
			console.log(`[WebRTC] online on 0.0.0.0:${this.port}`);
		}
	}

	async stop() {
		closeDatabase();
		this.server.close();
	}
}
