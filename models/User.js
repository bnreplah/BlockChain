const userSchema = {
        name:{
            type: String,
            required: true,
            min: 6,
            max: 255,
            description: "The name of the user"
        },
        email:{
            type: String,
            required: true,
            max: 255,
            min: 6,
            description: "The email of the user"
        },
        password:{
            type: String,
            required: true,
            max: 1024,
            min: 10,
            description: "The users hashed password"
        },
        date:{
            type:Date,
            default: Date.now(),
        }    
}



