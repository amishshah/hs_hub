import { Request, Response } from "express";
import { EventEmitter } from "events";

export class Subscriber extends EventEmitter {
    private _req: Request;
    private _res: Response;

    constructor(req: Request, res: Response) {
        super();
        this._req = req;
        this._res = res;

        this._req.on("close", () => this.emit("close"));
    }

    public send(packet: Object) {
        return this.write(Subscriber.serialisePacket(packet));
    }

    public write(data: String) {
        return this._res.write(data);
    }

    public end() {
        return this._res.end();
    }

    public static serialisePacket(packet: Object) {
        return `data: ${JSON.stringify(packet)}\n\n`;
    }
}
