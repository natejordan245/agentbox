/** The worker `yourTime` starts: one read, posted back, then ended. It reads
 *  the database itself and nothing the server's thread keeps in memory. */

import { readYourTime, type YourTimeJob } from "./yourtime";

declare const self: Worker;

self.onmessage = (e: MessageEvent<YourTimeJob>) => {
  self.postMessage(readYourTime(e.data));
};
