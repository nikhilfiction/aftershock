import { EventEmitter } from "node:events";

/** Shared event bus. Listeners are attached by name, so reading the code
 * cannot tell who runs when an event is emitted. */
export const events = new EventEmitter();
