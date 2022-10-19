let User = function (id, name, username, email, role, date, rank, rating, updated = false, previous = null){
    this.id = id;
    this.name = name;
    this.username = username;
    this.email = email;
    this.role = role;
    this.date = date;
    this.rank = rank;
    this.rating = rating;
    this.previous = previous;
}

User.prototype.getId = function(){
    return this.id;
}

User.prototype.getName = function(){
    return this.name;
}

User.prototype.getUsername = function(){
    return this.username;
}

User.prototype.getDate = function(){
    return this.date;
}

User.prototype.getEmail = function(){
    return this.email;
}

User.prototype.getRole = function (){
    return this.getRole;
}

User.prototype.getRating = function (){
    return this.rating;
}

User.prototype.getPrevious = function (){
    return this.previous;
}

User.prototype.update = function (){
    return new User(this.id, this.name, this.username, this.email, `${Date.now()}` ,this.role, this.rank, this.rating, true, this);
}

User.prototype.setName = function(nName){
    this.name = nName;
}

User.prototype.setEmail = function (nEmail){
    this.email = nEmail;
}

User.prototype.setRank = function(nRank){
    this.rank = nRank;
}

module.exports = User;