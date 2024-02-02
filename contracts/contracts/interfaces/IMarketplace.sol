// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

interface IMarketplace {
    event Listed(address collection, uint id, uint price, address lister);

    event PriceChanged(address collection, uint id, uint price);

    event Unlisted(address collection, uint id);

    event Bought(address collection, uint id, address buyer);

    event Offered(address collection, uint id, uint amount, address proposer);

    event OfferRemoved(address collection, uint id, address proposer);

    event OfferAccepted(address collection, uint id, uint amount, address proposer);

    function list(address collection, uint id, uint price) external;

    function changePrice(address collection, uint id, uint price) external;

    function unlist(address collection, uint id) external;

    function buy(address collection, uint id) external payable;

    function offer(address collection, uint id) external payable;

    function removeOffer(address collection, uint id) external;

    function acceptOffer(address collection, uint id, address proposer) external;
}
