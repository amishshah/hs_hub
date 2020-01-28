import { Request, Response } from "express";
import { Subscriber } from "../../util/sse";
import { inject, injectable } from "inversify";

export interface HardwareSSEServiceInterface {
    broadcast: (data: Object) => void;
    addSubscriber: (subscriber: Subscriber) => void;
}

@injectable()
export class HardwareSSEService implements HardwareSSEServiceInterface {
    private _subscribers: Set<Subscriber>;
    
    constructor() {
        this._subscribers = new Set([]);
    }

    public addSubscriber(subscriber: Subscriber) {
        this._subscribers.add(subscriber);
        subscriber.once("close", () => this._subscribers.delete(subscriber));
    }

    public broadcast(packet: Object) {
        const data = Subscriber.serialisePacket(packet);
        for (const subscriber of this._subscribers) {
            subscriber.write(data);
        }
    }
}
