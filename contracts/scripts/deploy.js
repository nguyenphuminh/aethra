const hre = require("hardhat");

async function main() {
    const [ deployer ] = await hre.ethers.getSigners();

    // Deploy MyNFT contract
    const MyNFT = await hre.ethers.getContractFactory("MyNFT");
    const myNFT = await MyNFT.deploy("Aethra Community", "AREA", "0x0000000000000000000000000000000000000000");

    await myNFT.deployed();

    console.log("Aethra Community deployed to:", myNFT.address);

    // Deploy Marketplace contract
    const Marketplace = await hre.ethers.getContractFactory("Marketplace");
    const marketplace = await Marketplace.deploy();

    await marketplace.deployed();

    console.log("Marketplace deplyed to:", marketplace.address);

    // FOR TESTING PURPOSES ONLY
    // await marketplace.list();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
