
const Chain = function(){
    this.head = true;
    this.next = null;
    this.data = null;
}

Chain.prototype.length = ()=>{
    return Chain.getSize() + 1;
}

Chain.prototype.getSize = function(){
    let count = 0;
    for(let node = this, nextNode = this.next; nextNode; node = nextNode, nextNode = nextNode.getNext(), count++);
    return count;
}

Chain.prototype.getLast = function(){
    
    if(this.next){
        
        return this.next.getLast();
    }else{
        return this;
    }
}

Chain.prototype.getNext = function(){
    return this.next;
}

Chain.prototype.setData = function(nData){
    this.data = nData;
}

Chain.prototype.push = function(nData){
    let lastLink = this.getLast();
    let newLink = new Chain();
    newLink.setData(nData);
    newLink.head = false;
    lastLink.next = newLink;
}


module.exports = Chain;