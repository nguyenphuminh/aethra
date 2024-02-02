require("@nomiclabs/hardhat-waffle");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    /*settings: {
      optimizer: {
        enabled: true,
        runs: 2000,
      },
    },*/
  },
  networks: {
    areon: {
      url: "https://testnet-rpc.areon.network",
      accounts: ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"]
    },
    hardhat: {
      mining: {
        auto: false,
        interval: 5000
      }
    }
  }
};
