import { RPC } from "./dist//core/server.js";
import config from "./aethra.config.js";
const rpc = new RPC(config);

rpc.startServer();
