/// <reference lib="webworker" />
import { createHost } from './host';

const handle = createHost((m) => (self as unknown as Worker).postMessage(m));
self.onmessage = (ev: MessageEvent) => handle(ev.data);
