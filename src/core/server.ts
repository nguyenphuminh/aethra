// Bad RPC server implementation, will be updated soon.

"use strict";

import Fastify from "fastify";
import { Level } from "level";
import crypto, { sign } from "crypto";
import cors from "@fastify/cors";
import { ethers } from "ethers";
import { clog, cerror } from "./utils.js";
import { MessageQueue } from "./queue.js";
import { abi } from "../contracts/erc721.js";
import { IPFSHTTPClient, create } from "kubo-rpc-client";
import { CID } from "multiformats/cid";
import { appendFileSync, existsSync, writeFileSync, createReadStream, createWriteStream, readFileSync, unlinkSync, renameSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import http from "http";
import https from "https";
import AWS from "aws-sdk";
import * as marketplace from "../contracts/marketplace.js";
import OpenAI from "openai";

const __dirname = dirname(fileURLToPath(import.meta.url));
// const SHA256 = (message: string) => crypto.createHash("sha256").update(message).digest("hex");

const fastify = Fastify({
    // 10 MB message limit
    bodyLimit: 10485760
});

const publicPath = __dirname + "/../../public";

export class QueryResult {
    constructor(public result: any, public errorMessage: string = "") {}
}

export interface RPCOptions {
    RPC_PORT: number;
    DB_PATH: string;
    DATA_PATH: string;
    ETH_RPC_URL: string;
    IPFS_RPC_URL: string;
    SPACES_ENDPOINT: string;
    CDN_URL: string;
    ACCESS_KEY: string;
    SECRET_KEY: string;
    BUCKET_NAME: string;
    PRIVATE_KEY: string;
}

export interface ReplyBody {
    success: boolean;
    payload: any;
    error: { message: string } | undefined;
}

export class RPC {
    public rpcPort: number;
    public db: Level;
    public dbPath: string;
    public dataPath: string;
    public provider: ethers.JsonRpcProvider;
    public signer: ethers.Wallet;
    // A queue used for synchronous operations
    public messageQueue: MessageQueue = new MessageQueue();
    public ipfsClient: IPFSHTTPClient;
    public s3: AWS.S3;
    public bucketName: string;
    public cdnURL: string;
    // Contracts
    public marketplace: ethers.Contract;
    // AI
    public openai: OpenAI;

    constructor(options: RPCOptions) {
        this.rpcPort = options.RPC_PORT || 20297;
        this.dbPath = options.DB_PATH || "./db";
        this.dataPath = options.DATA_PATH || "./data";
        this.db = new Level(this.dbPath);
        this.provider = new ethers.JsonRpcProvider(options.ETH_RPC_URL);
        this.signer = new ethers.Wallet(options.PRIVATE_KEY, this.provider);
        this.ipfsClient = create({ url: options.IPFS_RPC_URL.slice(0, options.IPFS_RPC_URL.length - 1) });

        const spacesEndpoint = new AWS.Endpoint(options.SPACES_ENDPOINT);
        this.s3 = new AWS.S3({
            endpoint: spacesEndpoint,
            accessKeyId: options.ACCESS_KEY,
            secretAccessKey: options.SECRET_KEY
        });
        this.bucketName = options.BUCKET_NAME;
        this.cdnURL = options.CDN_URL;

        this.marketplace = new ethers.Contract(marketplace.address, marketplace.abi, this.provider);

        this.openai = new OpenAI();
    }

    downloadFile(filePath: string, url: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (url.includes("https://")) {
                const file = createWriteStream(filePath);
                https.get(url, function(response) {
                    response.pipe(file);

                    // After download completed, close filestream
                    file.on("finish", () => {
                        file.close();
                        resolve();
                    });
                }).on("error", function(err) { // Handle errors
                    reject(err);
                });
            } else {
                const file = createWriteStream(filePath);
                http.get(url, function(response) {
                    response.pipe(file);

                    // After download completed, close filestream
                    file.on("finish", () => {
                        file.close();
                        resolve();
                    });
                }).on("error", function(err) { // Handle errors
                    reject(err);
                });
            }
        })
    }

    uploadToCDN(filePath: string): Promise<AWS.S3.ManagedUpload.SendData> {
        // Create a read stream from the file
        const fileStream = createReadStream(filePath);
        const fileName = filePath.split("/").at(-1)!;
    
        fileStream.on("error", function(err) {
            console.log(err);
        });
    
        // Set up the S3 upload parameters
        const uploadParams = {
            Bucket: this.bucketName,
            Key: fileName,
            Body: fileStream,
            ACL: "public-read"
        };
    
        // Upload the stream
        return this.s3.upload(uploadParams).promise();
    }

    async queryNFTMetadata(address: string, id: bigint, reset: boolean = false): Promise<QueryResult> {
        let tokenURI = "", fetchableURL = "", metadata = "";

        // Get token URI
        try {
            // Check if URI and metadata has been stored before
            try {
                tokenURI = await this.db.get(`NFT_URI${address} ${id}`);
                metadata = await this.db.get(`NFT_METADATA${address} ${id}`);

                // Parse metadata to JSON if possible
                try {
                    metadata = JSON.parse(metadata);
                } catch (e) {}

                // Only return if we don't want metadata to be reset
                if (!reset) return new QueryResult({ tokenURI, metadata });
            } catch (e) {}

            // Get the token URI from chain
            const nftContract = new ethers.Contract(address, abi, this.provider);

            tokenURI = await nftContract.tokenURI(BigInt(id));
            
            // Check if URI is an IPFS link 
            if (tokenURI.includes("ipfs://")) {
                // Fetch the data from the provided URI
                fetchableURL = tokenURI.replace("ipfs://", "http://127.0.0.1:8080/ipfs/");
            } else {
                // Fetch the data from the provided URI
                fetchableURL = tokenURI;
            }

            // Store URI, so we would not need to request it next time
            await this.db.put(`NFT_URI${address} ${id}`, tokenURI);
        } catch (e) {
            console.log(e);
            return new QueryResult(null, "An unexpected error occurred while getting NFT URI.");
        }

        // Get metadata
        try {
            metadata = (await axios.get(fetchableURL)).data;
        } catch (e) {
            console.log(fetchableURL, tokenURI);
            return new QueryResult(null, "An unexpected error occurred while getting NFT metadata.");
        }
        
        // Store metadata, so we would not need to request it next time
        await this.db.put(`NFT_METADATA${address} ${id}`, JSON.stringify(metadata));

        return new QueryResult({ tokenURI, metadata });
    }

    async startServer() {
        process.on("uncaughtException", err => console.log(`\x1b[31mERROR\x1b[0m [${(new Date()).toISOString()}] Uncaught Exception`, err));

        await this.initDB();

        await fastify.register(cors, { 
            origin: true
        })

        // Handle listings, buys and offers
        this.handleEvents();

        // Used for quick liveness check
        fastify.get("/", async (req, reply) => {
            reply.send("Beep boop beep boop!");
        });

        // Get banner of a collection
        fastify.get("/banner/:contract", async (req, reply) => {
            const params: any = req.params;
            const address = params.contract;

            reply.redirect(`${this.cdnURL}/banner${address}`);
        })

        // Get logo of a collection
        fastify.get("/logo/:contract", async (req, reply) => {
            const params: any = req.params;
            const address = params.contract;

            reply.redirect(`${this.cdnURL}/logo${address}`);
        })

        // Get image of an NFT
        fastify.get("/cdn/nft/:contract/:id", async (req, reply) => {
            function throwError() {
                reply.status(400);
                reply.send("ERROR");
            }

            const params: any = req.params;
            const address = params.contract;
            const id = params.id;

            // Check if NFT image is already downloaded or not
            try {
                // Check if image is cached or not
                await this.db.get(`IMAGE_CACHED${address} ${id}`);
                reply.redirect(`${this.cdnURL}/${address}_${id}`);
                return;
            } catch (e) {}

            // If it is not already downloaded, download directly
            const queryResult = await this.queryNFTMetadata(address, BigInt(id));

            if (queryResult.errorMessage.length === 0) {
                const { metadata } = queryResult.result;

                let fetchableURL = "";

                if (typeof metadata === "object" && typeof metadata.image === "string") {
                    // Get image and store into /public

                    // If the NFT supports IPFS
                    if (metadata.image.includes("ipfs://")) {
                        fetchableURL = metadata.image.replace("ipfs://", "http://127.0.0.1:8080/ipfs/");
                    } else { // If the NFT supports other fetchable protocols
                        fetchableURL = metadata.image;   
                    }

                    // Try fetching the data from the provided image url
                    try {
                        // Download the data into a file
                        await this.downloadFile(`${publicPath}/${address}_${id}`, fetchableURL);
                        // Upload file to CDN
                        await this.uploadToCDN(`${publicPath}/${address}_${id}`);
                        // Remove file from local storage
                        unlinkSync(`${publicPath}/${address}_${id}`);
                        // Note that we have cached the image for this NFT
                        await this.db.put(`IMAGE_CACHED${address} ${id}`, "");
                        reply.redirect(`${this.cdnURL}/${address}_${id}`);
                    } catch (e) {
                        console.log(e);
                        throwError();
                    }
                }
            } else {
                throwError();
            }
        });

        // Main RPC methods handler
        fastify.post("/", async (req: any, reply: any) => {
            function throwError(message: string, status: number, payload: any = null) {
                reply.status(status);

                reply.send({
                    success: false,
                    payload: null,
                    error: { message }
                });
            }

            function respond(payload: any) {
                reply.send({
                    success: true,
                    payload
                })
            }

            if (typeof req.body !== "object" || typeof req.body.params !== "object" || typeof req.body.method !== "string") {
                throwError("Bad request form.", 400);

                return;
            }

            switch (req.body.method) {
                /*//////////////////////////////////////////////////////////////
                                            Get info
                //////////////////////////////////////////////////////////////*/

                case "getCollections":
                    {
                        const listedNFTs = JSON.parse(await this.db.get("LISTED_NFTS"));
                        const collections = Object.keys(listedNFTs);

                        respond({ collections });
                    }

                    break;

                case "getCollectionInfo":
                    {
                        // const nftContract = new ethers.Contract(req.body.params.address, abi, this.provider);
                        const listedNFTs = JSON.parse(await this.db.get("LISTED_NFTS"));
                        const collection = listedNFTs[req.body.params.address];
                        const nftList = Object.keys(collection);

                        respond({ nftList });
                    }

                    break;

                case "getNFTInfo":
                    const reset = req.body.params.reset || false;
                    const queryResult = await this.queryNFTMetadata(req.body.params.address, BigInt(req.body.params.id), reset);

                    if (queryResult.errorMessage.length === 0) {
                        // Get NFT owner
                        const nftContract = new ethers.Contract(req.body.params.address, abi, this.provider);
                        const owner = await nftContract.ownerOf(BigInt(req.body.params.id));

                        // Get offers
                        let offers = [];
                        try {
                            offers = JSON.parse(await this.db.get(`OFFERS${req.body.params.address} ${req.body.params.id}`));
                        } catch (e) {}

                        // Get NFT price
                        // If price is -1, it is not listed yet
                        let price = "-1", lister = owner;
                        try {
                            // Get all listed NFTs
                            const listedNFTs = JSON.parse(await this.db.get("LISTED_NFTS"));
                            const nftListInfo = listedNFTs[req.body.params.address][req.body.params.id];

                            console.log(listedNFTs);
                            console.log(nftListInfo);

                            price = nftListInfo.price;
                            lister = nftListInfo.lister;
                        } catch (e) {}

                        respond({ ...queryResult.result, owner, offers, price, lister });
                    } else {
                        throwError(queryResult.errorMessage, 400);
                    }

                    break;


                /*//////////////////////////////////////////////////////////////
                                              Create
                //////////////////////////////////////////////////////////////*/

                case "createStream":
                    try {
                        const randomFilename = crypto.randomBytes(20).toString("hex");
                    
                        writeFileSync(`${this.dataPath}/${randomFilename}`, "");

                        respond({ fileKey: randomFilename });
                    } catch (e) {
                        throwError("An unexpected error occurred while creating file stream.", 400);
                    }

                    break;

                case "streamAdd":
                    try {
                        const chunk = req.body.params.chunk;

                        appendFileSync(`${this.dataPath}/${req.body.params.fileKey}`, chunk.slice(0, 2) === "0x" ? Buffer.from(chunk.slice(2), "hex") : chunk);

                        respond(null);
                    } catch (e) {
                        throwError("An unexpected error occurred while adding to file stream.", 400);
                    }

                    break;
                
                case "createTokenURI":
                    // Pin content to IPFS
                    let metadata: string = "";

                    try {
                        const stream = createReadStream(`${this.dataPath}/${req.body.params.fileKey}`);
                        const { cid } = await this.ipfsClient.add(stream);
                        await this.ipfsClient.pin.add(cid);

                        // Generate metadata
                        metadata = JSON.stringify({
                            name: req.body.params.name,
                            description: req.body.params.description,
                            image: `ipfs://${cid.toString()}`,
                            attributes: req.body.params.attributes
                        });
                    } catch (e) {
                        console.log(e);

                        throwError("An unexpected error occurred while pinning content to IPFS.", 400);            
                        return;
                    }

                    // Pin metadata to IPFS
                    try {
                        const { cid } = await this.ipfsClient.add(metadata);
                        await this.ipfsClient.pin.add(cid);
                        
                        respond({ metadata, cid: cid.toString() });
                    } catch (e) {
                        console.log(e);

                        throwError("An unexpected error occurred while pinning metadata to IPFS.", 400);
                    }

                    break;

                case "updateBackground":
                    // Verify sig

                    try {
                        // Rename file name from file key to contract address
                        if (existsSync(`${this.dataPath}/${req.body.params.fileKey}`)) {
                            // If file already exists, throw error
                            if (existsSync(`${this.dataPath}/banner${req.body.params.address}`)) {
                                throwError("An unexpected error occurred while updating background.", 400);
                                return;
                            }

                            renameSync(`${this.dataPath}/${req.body.params.fileKey}`, `${this.dataPath}/banner${req.body.params.address}`);
                        }
                        // Upload file to CDN
                        await this.uploadToCDN(`${this.dataPath}/banner${req.body.params.address}`);
                        // Delete file
                        unlinkSync(`${this.dataPath}/banner${req.body.params.address}`);
                    } catch (e) {
                        throwError("An unexpected error occurred while updating background.", 400);
                    }

                    respond(null);

                    break;

                case "updateLogo":
                    // Verify sig

                    try {
                        // Rename file name from file key to contract address
                        if (existsSync(`${this.dataPath}/${req.body.params.fileKey}`)) {
                            // If file already exists, throw error
                            if (existsSync(`${this.dataPath}/logo${req.body.params.address}`)) {
                                throwError("An unexpected error occurred while updating background.", 400);
                                return;
                            }

                            renameSync(`${this.dataPath}/${req.body.params.fileKey}`, `${this.dataPath}/logo${req.body.params.address}`);
                        }
                        // Upload file to CDN
                        await this.uploadToCDN(`${this.dataPath}/logo${req.body.params.address}`);
                        // Delete file
                        unlinkSync(`${this.dataPath}/logo${req.body.params.address}`);
                    } catch (e) {
                        throwError("An unexpected error occurred while updating background.", 400);
                    }

                    respond(null);

                    break;

                case "updateLinks":
                    // Verify sig

                    try {
                        if (typeof req.body.params.website === "string") {
                            await this.db.put("WEBSITE" + req.body.params.address, req.body.params.website);
                        }
    
                        if (typeof req.body.params.twitter === "string") {
                            await this.db.put("TWITTER" + req.body.params.address, req.body.params.twitter);
                        }
    
                        if (typeof req.body.params.discord === "string") {
                            await this.db.put("DISCORD" + req.body.params.address, req.body.params.discord);
                        }
                    } catch (e) {
                        throwError("An unexpected error occurred while updating links.", 400);
                        return;
                    }

                    respond(null);
                
                    break;
                
                case "getLinks":
                    try {
                        if (typeof req.body.params.website === "string") {
                            await this.db.get("WEBSITE" + req.body.params.address);
                        }
    
                        if (typeof req.body.params.twitter === "string") {
                            await this.db.get("TWITTER" + req.body.params.address);
                        }
    
                        if (typeof req.body.params.discord === "string") {
                            await this.db.get("DISCORD" + req.body.params.address);
                        }
                    } catch (e) {
                        throwError("An unexpected error occurred while updating links.", 400);
                        return;
                    }

                    respond(null);
                    
                    break;

                case "generateAIImage":
                    try {
                        const response = await this.openai.images.generate({
                            model: "dall-e-3",
                            prompt: req.body.params.prompt,
                            n: 1,
                            size: req.body.params.size || "1024x1024",
                        });

                        await this.downloadFile(`${this.dataPath}/${req.body.params.fileKey}`, response.data[0].url!);

                        respond(null);
                    } catch (e) {
                        console.log(e);

                        throwError("An unexpected error occurred while generating image using AI.", 400);
                        return;
                    }

                    break;

                default:
                    throwError("Invalid method.", 404);
            }
        });

        // Server starts listening
        fastify.listen(this.rpcPort, "0.0.0.0", (err, address) => {
            if (err) {
                cerror(`Error at RPC server: Fastify: ` + err);
                process.exit(1);
            }
    
            clog(`AIDot RPC server listening at address ${address}`);
        });

        /*
        try {
            await fastify.listen(this.RPC_PORT, "0.0.0.0");
            clog(`AIDot RPC server listening on PORT ${this.RPC_PORT}`);
        } catch (err) {
            cerror(`Error at RPC server: Fastify: ` + err);
            process.exit(1);
        }*/
    }

    async initDB() {
        // Only init if DB does not exist
        if (!existsSync(this.dbPath)) {
            // Slot to store all listed NFT collections
            await this.db.put("LISTED_NFTS", "{}");
        }
    }

    handleEvents() {
        this.marketplace.on("Listed", async (collection, id, price, lister) => {
            this.messageQueue.add(async () => {
                try {
                    // Add new NFT to list of listed NFTs
                    const listedNFTs = JSON.parse(await this.db.get("LISTED_NFTS"));
                    if (!listedNFTs[collection]) {
                        listedNFTs[collection] = {};
                    }
                    listedNFTs[collection][id.toString()] = { price: price.toString(), lister };
                    await this.db.put("LISTED_NFTS", JSON.stringify(listedNFTs));

                    // Initiate offer list for this NFT
                    await this.db.put(`OFFERS${collection} ${id}`, "{}");

                    console.log(listedNFTs); // For debugging purposes
                } catch (e) {
                    console.log(e);
                }
            });
        });

        this.marketplace.on("PriceChanged", async (collection, id, price) => {
            this.messageQueue.add(async () => {
                // Delete NFT from list of listed NFTs
                const listedNFTs = JSON.parse(await this.db.get("LISTED_NFTS"));
                listedNFTs[collection][id].price = price.toString();
                await this.db.put("LISTED_NFTS", JSON.stringify(listedNFTs));
                // Remove list of offers for an NFT
                await this.db.del(`OFFERS${collection} ${id}`);

                console.log(listedNFTs); // For debugging purposes
            });
        });

        this.marketplace.on("Unlisted", async (collection, id) => {
            this.messageQueue.add(async () => {
                // Delete NFT from list of listed NFTs
                const listedNFTs = JSON.parse(await this.db.get("LISTED_NFTS"));
                delete listedNFTs[collection][id];
                await this.db.put("LISTED_NFTS", JSON.stringify(listedNFTs));
                // Remove list of offers for an NFT
                await this.db.del(`OFFERS${collection} ${id}`);

                console.log(listedNFTs); // For debugging purposes
            });
        });

        this.marketplace.on("Bought", async (collection, id, buyer) => {
            this.messageQueue.add(async () => {
                // Delete NFT from list of listed NFTs
                const listedNFTs = JSON.parse(await this.db.get("LISTED_NFTS"));
                delete listedNFTs[collection][id];
                await this.db.put("LISTED_NFTS", JSON.stringify(listedNFTs));
                // Remove list of offers for an NFT
                await this.db.del(`OFFERS${collection} ${id}`);

                console.log(listedNFTs); // For debugging purposes
            });
        });

        this.marketplace.on("Offered", (collection, id, amount, proposer) => {
            this.messageQueue.add(async () => {
                // Add new offer to list of offers for an NFT
                let offers: Record<string, string> = {};
                try {
                    offers = JSON.parse(await this.db.get(`OFFERS${collection} ${id}`));
                } catch (e) {}
                offers[proposer] = amount.toString();
                await this.db.put(`OFFERS${collection} ${id}`, JSON.stringify(offers));

                console.log(offers); // For debugging purposes
            });
        });

        this.marketplace.on("OfferRemoved", (collection, id, proposer) => {
            this.messageQueue.add(async () => {
                // Delete offer in list of offers for an NFT
                let offers: Record<string, string> = {};
                try {
                    offers = JSON.parse(await this.db.get(`OFFERS${collection} ${id}`));
                } catch (e) {
                    // If a list of offers can not be queried, it means that the NFT is sold
                    // and we do not need to care about it any more
                    return;
                }
                delete offers[proposer];
                await this.db.put(`OFFERS${collection} ${id}`, JSON.stringify(offers));

                console.log(offers); // For debugging purposes
            });
        });

        this.marketplace.on("OfferAccepted", (collection, id, amount, proposer) => {
            this.messageQueue.add(async () => {
                // Remove list of offers for an NFT
                await this.db.del(`OFFERS${collection} ${id}`);
            });
        });
    }
}
