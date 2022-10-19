//const Chain = require('./Chain');

const { SHA256 } = require("crypto-js");
const CURRENT_NODE_URL = process.argv[3];
const uuId = require('crypto-random-string');

const Blockchain = function(){
    this.chain = [];
    this.pendingTransactions = [];
    this.currentNodeUrl = CURRENT_NODE_URL;
    this.genesis = "00000";
    this.createNewBlock(77430, "00000","00000");
    this.PoW('00000',{transactions: [], index: 0, data: {CURRENT_NODE_URL}});
    console.log(this);
    this.networkNode = [];
}



Blockchain.prototype.createNewBlock = function (nonce, previousBlockHash, hash){
    
    const newBlock = {
        index: this.chain.length + 1,
        timestamp: Date.now(),
        transactions: this.pendingTransactions,
        nonce: nonce,
        hash: hash,
        previousBlockHash: previousBlockHash,
    };
    this.pendingTransactions = [];
    //verify would go here
    this.chain.push(newBlock);
    return newBlock;

}

Blockchain.prototype.getLastBlock = function(){
    if(this.chain.length > 0){
        return this.chain[this.chain.length - 1]//this.chain.getLast();

    }
    else{
        return this.chain.length;
    }
}

Blockchain.prototype.createNewTransaction = function(type, data, sender, recipient){
    const newTransaction = {
        data: data, 
        sender: sender,
        recpient: recipient,
        type: type,
        transactionId : `${SHA256(uuId(64).toString()).toString()}`
    };
    return newTransaction
    // this.pendingTransactions.push(newTransaction);
    // return this.getLastBlock()['index'] + 1;


}

Blockchain.prototype.addTransactionToPendingTransactions = function(transObj){
    this.pendingTransactions.push(transObj);
    return this.getLastBlock()['index'] + 1;
};



Blockchain.prototype.getGenesisSig = function (){
    return this.genesis;
}

Blockchain.prototype.hashBlock = function(previousBlockHash, currentBlockData, nonce){
    const dataAsString = previousBlockHash + nonce + JSON.stringify(currentBlockData);
    const hash = SHA256(dataAsString);
    // console.log(`${hash}`);
    return `${hash}`;

}

Blockchain.prototype.PoW = function (previousBlockHash, currentBlockData){
    let nonce = 0; 
    let hash = this.hashBlock(previousBlockHash, currentBlockData, nonce);
    while(hash.substring(0,4) !== '0000'){
        nonce++;
        hash = this.hashBlock(previousBlockHash, currentBlockData, nonce);
    }
    const reciept = { hash: SHA256(nonce + this.currentNodeUrl + previousBlockHash + hash ).toString(),
                      timestamp: Date.now(),
                      status: "--"
                    };
    return [nonce, reciept];


};


Blockchain.prototype.getBlock = function(blockHash){
    let foundBlock = null;
    this.chain.forEach(block =>{
        if(block.hash === blockHash){
            foundBlock = block;
        }
    });
    return foundBlock;

}

Blockchain.prototype.getTransaction= function (transactionId){
    let foundTrans = null;
    let foundBlock = null;
    this.chain.forEach(block=>{
        block.transactions.forEach(transaction =>{
            if(transacton.transactionId === transactionId){
                foundTrans = transaction;
                foundBlock = block;

            }
        });
    });
    return {transaction: foundTrans, 
            block: foundBlock,};
};

Blockchain.prototype.getAddressData = function (address){
    const addressTransactions = [];
    this.chain.forEach(block=>{
        block.transactions.forEach(transaction =>{
            if(transaction.sender === address || transaction.recipient === address){
                addressTransactions.push(transaction);
            }
        });
    });
    let balance = 0;
    addressTransactions.forEach(transaction =>{
        if(transaction.type === "g0ld"){
            if(transaction.recipient === address){
                balance += transaction.data;
            }else if(transaction.sender === address){
                balance -= transaction.data;
            }
        }
    });
    return {
        addressTransactions: addressTransactions,
        addressBalance: balance
    };
};

Blockchain.prototype.chainIsValid= function (blockchain){
    let validChain = true;
    const genesisBlock = blockchain[0];
    const correctNonce = genesisBlock['nonce'] === 77430;
    const correctPreviousBlockHash = genesisBlock['previousBlockHash'] === "00000";
    const correctHash = genesisBlock['hash'] === "00000";
    const correctTransactions = genesisBlock['transactions'].lenght === 0;
    if(!correctNonce || !correctPreviousBlockHash || !correctHash || !correctTransaction){
        validChain = false;
    }//end if

    for(var i = 1; i < blockchain.length; i++){
        const currentBlock = blockchain[i];
        const prevBlock = blockchain[i-1];
        const blockHash = this.hashBlock(prevBlock['hash'],{transactions: currentBlock['transactions'],
        index: currentBlock['index'] },currentBlock['nonce']);
        if(blockHash.substring(0,4) !== "0000")
        if(currentBlock['previousBlockHash'] !== prevBlock['hash']){
            validChain = false;
        }//end if
    };
    return validChain;

};

module.exports = Blockchain;