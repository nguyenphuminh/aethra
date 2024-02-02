// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

contract MyNFT is ERC721URIStorage {
    uint256 private _tokenIds;
    address private _owner;

    constructor(string memory name, string memory symbol, address owner) ERC721(name, symbol) {
        _owner = owner;
    }

    function mintNFT(address recipient, string memory tokenURI) external returns (uint256) {
        // If owner is set to 0x0, anyone can mint an NFT for this collection
        require(_owner == msg.sender || _owner == address(0), "Only owner of the collection can mint NFTs");

        _tokenIds++;

        _mint(recipient, _tokenIds);
        _setTokenURI(_tokenIds, tokenURI);

        emit NFTMinted(recipient, _tokenIds);

        return _tokenIds;
    }

    event NFTMinted(address recipient, uint256 id);
}
