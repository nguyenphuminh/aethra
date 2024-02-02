// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import "./interfaces/IMarketplace.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract Marketplace is IMarketplace {
    mapping(address => mapping(uint => uint)) public priceOf;
    mapping(address => mapping(uint => address)) public ownerOf;
    mapping(address => mapping(uint => mapping(address => uint))) public offers;
    mapping(address => mapping(uint => bool)) public sold;

    function list(address collection, uint id, uint price) external {
        // Transfer the NFT from owner to our marketplace, user must approve before
        IERC721(collection).safeTransferFrom(msg.sender, address(this), id);

        // Store the price
        priceOf[collection][id] = price;
        // Store the owner
        ownerOf[collection][id] = msg.sender;
        // Open sale
        sold[collection][id] = false;
        
        emit Listed(collection, id, price, msg.sender);
    }

    function changePrice(address collection, uint id, uint price) external {
        require(ownerOf[collection][id] == msg.sender, "Only owner can set price");

        // Store the price
        priceOf[collection][id] = price;

        emit PriceChanged(collection, id, price);
    }

    function unlist(address collection, uint id) external {
        // Transfer the NFT from our marketplace to owner
        IERC721(collection).safeTransferFrom(msg.sender, address(this), id);

        // Close sale
        sold[collection][id] = true;

        emit Unlisted(collection, id);
    }

    function buy(address collection, uint id) external payable {
        require(msg.value >= priceOf[collection][id], "Amount sent is not enough");
        require(!sold[collection][id], "NFT must not be sold before");

        // Send NFT to buyer
        IERC721(collection).safeTransferFrom(address(this), msg.sender, id);
        // Transfer money to seller
        payable(ownerOf[collection][id]).transfer(priceOf[collection][id]);
        // Close sale
        sold[collection][id] = true;

        emit Bought(collection, id, msg.sender);
    }

    function offer(address collection, uint id) external payable {
        require(!sold[collection][id], "NFT must not be sold before");

        // Store offer
        offers[collection][id][msg.sender] = msg.value;

        emit Offered(collection, id, msg.value, msg.sender);
    }

    function removeOffer(address collection, uint id) external {
        // Withdraw money back
        payable(msg.sender).transfer(offers[collection][id][msg.sender]);
        // Remove offer
        offers[collection][id][msg.sender] = 0;

        emit OfferRemoved(collection, id, msg.sender);
    }

    function acceptOffer(address collection, uint id, address proposer) external {
        require(!sold[collection][id], "NFT must not be sold before");

        // Send money to owner
        payable(msg.sender).transfer(offers[collection][id][proposer]);
        // Send NFT to buyer
        IERC721(collection).safeTransferFrom(address(this), proposer, id);

        sold[collection][id] = true;

        emit OfferAccepted(collection, id, offers[collection][id][proposer], proposer);
    }


    // ERC-721 receiver
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
