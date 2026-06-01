//establish api


console.log("[--------------Configuring the server--------------]");

require('dotenv').config();//require the .env file for use
const express = require('express');//express for api server
const app = express(); //initialize the express object
const jwt = require('jsonwebtoken');//get the json web token models
app.use(express.json());//use json to parse the requests

// Optional bearer-token auth for the DARM-ANN API. Enabled by setting
// DARM_AUTH_TOKEN; off by default (back-compat). Health/metrics stay open so
// container probes and Prometheus can reach them without a credential.
const DARM_AUTH_TOKEN = process.env.DARM_AUTH_TOKEN || '';
const DARM_OPEN_PATHS = new Set(['/darm/health', '/darm/metrics']);
app.use((req, res, next)=>{
    if (!DARM_AUTH_TOKEN) return next();              // auth disabled
    if (!req.path.startsWith('/darm/')) return next(); // only guard DARM API
    if (DARM_OPEN_PATHS.has(req.path)) return next();  // probes/scrape exempt
    const h = req.headers['authorization'] || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-darm-token'] || '');
    if (token === DARM_AUTH_TOKEN) return next();
    return res.status(401).json({ error: 'unauthorized', hint: 'set Authorization: Bearer <DARM_AUTH_TOKEN>' });
});

const authRoute = require('./routes/auth');//require the middle ware for user use /api/user
const { SHA256 } = require('crypto-js');//used for hashing and crypto algorithms
const uuid = require('crypto-random-string');//creates a unique id of mathematically random bits ( not really uuid package but similar )
process.env.REFRESH_TOKEN = uuid(64).toString();//sets the refresh token at the start of the application
const port = process.argv[2];//gets the port from the second argument of the start command
const currentNodeUrl = process.argv[3];//gets the currentNodeUrl as the third argument of the start command
const rp = require('request-promise');//allows for promises ( compatible with wix )
//establish Chain
const Chain = require('./structures/Chain');//a link list data structure alternative to using an array for the block chain

console.log("[--------------[DEBUGGING]--------------]")
//[DEBUG]:
console.log("PROCESS ARGUMENTS => ");
console.log(...process.argv);//debugging prints out to the screen the arguments

//establish User and User authentication
const User = require('./account_classes/Users');
let refreshTokens = [];

//establish BlockChain
const Blockchain = require('./structures/Blockchain');

//establish node
const doC = Date.now();

//Node address of current node
const n0deAddress =  SHA256(uuid(64) + ":|:" + doC.toString()).toString();
console.log("save this [NODE UUID]: ", n0deAddress);

//Initialize the chain
let Bcoin = new Blockchain();

//get the genesis signature as the chainId
const chainID = Bcoin.getGenesisSig();
console.log(chainID);

// ****************************************************************************
// DARM-ANN v6.0 — Distributed Agentic Recursive Memory Network
// The existing PoW blockchain (Bcoin) is bridged in as the Long-Term Memory
// (LTM) tier. DARM-ANN layers the rest of the five-tier hierarchy
// (WM -> EB -> STM -> LTM -> RRC) plus CDCP consensus consolidation and the
// RCE replay engine on top of it. Fully self-contained: no Redis, no external
// LLM, no external consensus service. See darm-ann/README.md for the full
// mapping to the v6.0 white paper.
// ****************************************************************************
const fs = require('fs');
const DarmAnn = require('./darm-ann');
const { repoChainAdapter } = require('./darm-ann/network/chainAdapter');
// Persistence: set DARM_SNAPSHOT to a file path to restore on boot + save on exit.
const DARM_SNAPSHOT = process.env.DARM_SNAPSHOT || '';
// Env-tunable consensus config (production knobs, no code edits required).
const darmConfig = { cdcp: {} };
if (process.env.DARM_MIN_AGE_MS != null) darmConfig.cdcp.tMinAgeMs = Number(process.env.DARM_MIN_AGE_MS);
if (process.env.DARM_TAU_C != null) darmConfig.cdcp.tauC = Number(process.env.DARM_TAU_C);
let darm;
if (DARM_SNAPSHOT && fs.existsSync(DARM_SNAPSHOT)) {
    darm = DarmAnn.load(DARM_SNAPSHOT, { adapter: repoChainAdapter(Bcoin), config: darmConfig });
    console.log("[DARM-ANN] restored from snapshot", DARM_SNAPSHOT);
} else {
    darm = new DarmAnn({ nodeId: n0deAddress, adapter: repoChainAdapter(Bcoin), config: darmConfig });
}
darm.autorun(); // background RCE replay + STM triage + self-correction
console.log("[DARM-ANN] memory network online ->", JSON.stringify(darm.state().tiers));

// Periodic durable snapshot to the persistent volume (production deploy). The
// interval (ms) is DARM_SNAPSHOT_MS; 0 disables. Default 60s when a path is set.
const DARM_SNAPSHOT_MS = process.env.DARM_SNAPSHOT_MS != null ? Number(process.env.DARM_SNAPSHOT_MS) : (DARM_SNAPSHOT ? 60000 : 0);
let darmSnapshotTimer = null;
function persistSnapshot() {
    if (!DARM_SNAPSHOT) return null;
    darm.save(DARM_SNAPSHOT);
    return DARM_SNAPSHOT;
}
if (DARM_SNAPSHOT && DARM_SNAPSHOT_MS > 0) {
    darmSnapshotTimer = setInterval(() => { try { persistSnapshot(); } catch (e) { console.error("[DARM-ANN] periodic snapshot failed", e.message); } }, DARM_SNAPSHOT_MS);
    if (darmSnapshotTimer.unref) darmSnapshotTimer.unref();
}

// Graceful shutdown: persist the snapshot and stop background timers.
let darmShuttingDown = false;
function darmShutdown() {
    if (darmShuttingDown) return; darmShuttingDown = true;
    try { if (persistSnapshot()) console.log("[DARM-ANN] snapshot saved to", DARM_SNAPSHOT); } catch (e) { console.error("[DARM-ANN] snapshot save failed", e.message); }
    if (darmSnapshotTimer) clearInterval(darmSnapshotTimer);
    darm.stop();
    process.exit(0);
}
process.on('SIGINT', darmShutdown);
process.on('SIGTERM', darmShutdown);

// Gossip mempool: any node can submit a transaction; it is admitted locally and
// gossiped to registered network peers (HTTP), which re-gossip on first sight.
// A submitted 'memory' tx is observed into this node's memory pipeline.
const Mempool = require('./darm-ann/consensus/mempool');
const darmMempool = new Mempool({ nodeId: n0deAddress, fanout: 4, ttl: 4, onTx: (tx) => {
    if (tx.type === 'memory' && tx.payload && tx.payload.claim) {
        darm.observe({ claim: tx.payload.claim, reward: tx.payload.reward != null ? tx.payload.reward : 1, epistemic: tx.payload.epistemic });
    }
}});
// HTTP gossip: forward a tx to each registered network node's /darm/tx endpoint.
function gossipTxToPeers(tx, ttl) {
    if (ttl <= 0) return;
    (Bcoin.networkNode || []).forEach((peerUrl) => {
        rp({ uri: peerUrl + '/darm/tx', method: 'POST', body: { tx, ttl: ttl - 1 }, json: true }).catch(() => {});
    });
}

// ****************************************************************************
// ROUTES:
// ****************************************************************************



//needed for establishing the secure channel
//JWT 


//JWT entry point
// grants access to the given page showing the post authenticated for that user
// [Not tested yet]
app.get('/access', authenticateToken, (req, res)=>{
    res.json(posts.filter(post=> post.username === req.user.username))
});


//the authentication end point
// grants a newAuthentication tokena and new refresh token, needs some sort of authentication
// [Not Tested yet]
app.post('/login' ,function (req, res){
    //authenticate user
    const pssKey = req.body.signedPss;
    //some sort of authentication checking that the pss is signed by the users private key.
    //
    const loggedInUser = User(req.body.id, req.body.name, req.body.username, req.body.email)
    const accessToken = generateAuthenticationToken(loggedInUser);
    const refreshToken = generateRefreshToken(loggedInUser);
    refreshTokens.push(refreshToken);
    res.json({accessToken : accessToken,
              refreshToken: refreshToken});
});


//the token refresh endpoint
// grants the user a new authentication token if their refresh token is valid and not expired
//  [Not Tested Yet]
app.post('/token', (req, res)=>{
    const refreshToken = req.body.token;
    if(refreshToken == null)return res.sendStatus(401);
    if(refreshTokens.includes(refreshToken)) return res.sendStatus(403);
    jwt.verify(refreshToken, process.env.REFRESH_TOKEN, (err, user) =>{
        if(err) return res.sendStatus(403);
        const accessToken = generateAuthenticationToken(user);
        res.json({accessToken: accessToken, refreshToken: refreshToken});
    });
});

//ends the session and revokes the refresh token
// need to add revoking the authentication token too
// [Not Tested Yet]
app.post('/logout', (req, res)=>{
    refreshTokens = refreshTokens.filter(token => token !== req.body.token);
    res.sendStatus(204);
});

//  ************************************************************************
//  End JWT End points
//  ************************************************************************

//  ************************************************************************
//  User Endpoint Route
//  ************************************************************************



//register end point  
app.post("/register",function (req, res){
    const user = new User({
        name: req.body.name,
        email: req.body.email,
        password: req.body.password,
        uuid: "u=" + uuid(32).toString(),
        node: n0deAddress,
        timestamp: Date.now(),
        wallet : [],
    });
    //check if user already exists
    //if already exists prompt to login
    //else register user and create new transaction between the node and the user.
    
});


//Route middlewares
app.use('/api/user', authRoute);//everything in the offroute will have this prefix
//when we do to post request to register we need to go to /api/user/register


//  ************************************************************************
//  Node Endpoint Route
//  ************************************************************************


//Routes for blockchain
//presents the working blockchain held on this node
app.get("/blockchain", (req, res)=>{
    res.send(Bcoin);
});


//  ************************************************************************
//  DARM-ANN Memory Network Endpoints
//  ************************************************************************

// observe: ingest a completed inference/claim (WM -> EB -> STM)
app.post("/darm/observe", (req, res)=>{
    const result = darm.observe({
        claim: req.body.claim,
        claims: req.body.claims,
        reward: req.body.reward,
        epistemic: req.body.epistemic,
        agentId: req.body.agentId,
    });
    res.json({note: "Observation ingested into DARM-ANN", result});
});

// query: retrieve via the memory hierarchy (RRC -> STM -> LTM -> MISS)
app.get("/darm/query", (req, res)=>{
    res.json(darm.query(req.query.q || ""));
});

// teach / refute: seed the cluster knowledge graph (G_K) used by CDCP votes
app.post("/darm/teach", (req, res)=>{
    darm.teach(req.body.claim);
    res.json({note: "Fact grounded across cluster voters"});
});
app.post("/darm/refute", (req, res)=>{
    darm.refute(req.body.claim);
    res.json({note: "Claim marked refuted across cluster voters"});
});

// replay: run one RCE consolidation cycle (nominates STM survivors to LTM)
app.post("/darm/replay", (req, res)=>{
    res.json(darm.replay());
});

// triage: run STM lifecycle management
app.post("/darm/triage", (req, res)=>{
    res.json(darm.triage());
});

// state: Sigma(t) snapshot of tier occupancies and the associative graph
app.get("/darm/state", (req, res)=>{
    res.json(darm.state());
});

// navigate: model-directed traversal of the Markov chain-graph (TinyLM-steered)
app.get("/darm/navigate", (req, res)=>{
    res.json(darm.navigate(req.query.q || "", Number(req.query.steps) || 8));
});

// self-correct: validate/repair chains, prune TTL, supersede contradictions
app.post("/darm/selfcorrect", (req, res)=>{
    res.json(darm.selfCorrect());
});

// snapshot: persist durable state to disk (DARM_SNAPSHOT or body.path)
app.post("/darm/snapshot", (req, res)=>{
    const path = (req.body && req.body.path) || DARM_SNAPSHOT;
    if(!path) return res.status(400).json({error: "no snapshot path; set DARM_SNAPSHOT or body.path"});
    darm.save(path);
    res.json({note: "snapshot saved", path});
});

// health: liveness/readiness probe for deployment
app.get("/darm/health", (req, res)=>{
    const st = darm.state();
    const healthy = st.chains.stmValid && st.chains.ltmValid;
    res.status(healthy ? 200 : 503).json({status: healthy ? "ok" : "degraded", chains: st.chains, tiers: st.tiers});
});

// tx: submit a new transaction (origin) OR receive a gossiped one (peers).
// Origin submit:  body = { type, payload }      → admit locally + gossip
// Gossip relay:   body = { tx, ttl }            → verify, dedup, re-gossip
app.post("/darm/tx", (req, res)=>{
    if (req.body && req.body.tx) {
        // Inbound gossip from a peer.
        const before = darmMempool.seen.has(req.body.tx.id);
        darmMempool.handle({ type: 'TX_GOSSIP', ttl: req.body.ttl || 0, tx: req.body.tx });
        const admitted = !before && darmMempool.seen.has(req.body.tx.id);
        if (admitted) gossipTxToPeers(req.body.tx, req.body.ttl || 0);
        return res.json({ note: admitted ? "tx admitted + relayed" : "duplicate/ignored" });
    }
    // Origin submission.
    const tx = darmMempool.submit(req.body.type || 'memory', req.body.payload || {});
    gossipTxToPeers(tx, darmMempool.ttl);
    res.json({ note: "tx submitted and gossiped", tx: { id: tx.id, type: tx.type } });
});

// mempool: inspect pending transactions
app.get("/darm/mempool", (req, res)=>{
    res.json({ size: darmMempool.size(), pending: darmMempool.take(50).map(t => ({ id: t.id, type: t.type, origin: t.origin })) });
});

// alerts: Alertmanager webhook receiver. Records the most recent alerts so they
// surface in /darm/state and can drive automated responses.
const darmAlerts = [];
app.post("/darm/alerts", (req, res)=>{
    const incoming = (req.body && req.body.alerts) || [];
    for (const a of incoming) {
        darmAlerts.unshift({ status: a.status, name: a.labels && a.labels.alertname, severity: a.labels && a.labels.severity, instance: a.labels && a.labels.instance, at: Date.now() });
    }
    while (darmAlerts.length > 50) darmAlerts.pop();
    console.log(`[DARM-ANN] received ${incoming.length} alert(s)`);
    res.json({ note: "alerts received", count: incoming.length });
});
app.get("/darm/alerts", (req, res)=>{ res.json({ recent: darmAlerts.slice(0, 20) }); });

// metrics: Prometheus exposition format for scraping (Grafana dashboards)
const darmMetrics = require('./darm-ann/metrics');
const darmStartTime = Date.now();
app.get("/darm/metrics", (req, res)=>{
    const text = darmMetrics.render(darm, {
        mempoolSize: darmMempool.size(),
        uptimeSeconds: (Date.now() - darmStartTime) / 1000,
        networkNodes: (Bcoin.networkNode || []).length,
    });
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(text);
});

// validators: dynamic validator-set membership
app.get("/darm/validators", (req, res)=>{
    res.json({ validators: darm.validators(), membershipVersion: darm.state().cluster.membershipVersion });
});
app.post("/darm/validators", (req, res)=>{
    res.json(darm.addValidator(req.body || {}));
});
app.delete("/darm/validators/:id", (req, res)=>{
    res.json(darm.removeValidator(req.params.id));
});

// dashboard: a small operator UI over the endpoints
app.get(["/darm", "/darm/dashboard"], (req, res)=>{
    res.sendFile("./darm-ann/dashboard.html", {root: __dirname});
});


//transaction end point
// adds the transaction that was broadcasted from one of the nodes to the pending transactions upon consensus
app.post("/transaction",(req, res)=>{
   const newTransaction = req.body;
   const blockIndex = Bcoin.addTransactionToPendingTransactions(newTransaction);
    res.json({note: `Transaction will be added in block ${blockIndex}`});

});
    

//broadcast transaction end point
// broadcasts the transaction to the rest of the nodes
app.post("/transaction/broadcast", function(req, res){
    const newTransaction = Bcoin.createNewTransaction(req.body,type, req.body,data, req.body.sender, req.body.recipient);
    Bcoin.addTransactionToPendingTransactions(newTransaction);
    const requestPromises = [];
    Bcoin.networkNode.forEach(networkNodeUrl =>{
        const requestOptions ={
            uri: networkNodeUrl + '/transaction',
            method: 'POST',
            body: newTransaction,
            json: true
        };
        requestPromises.push(rp(requestOptions));
    });
    Promise.all(requestPromises).then(data=>{
        res.json({note: "Transaction created and broadcast succesfully"});
    })
});


//mine end point
// the mining end point that mines and sends the new transaction to the rest of the nodes
app.get("/mine", (req, res)=>{
      
      //authenticate
      const nodeAddress = n0deAddress;//sends mined coins to this node
      
      const lastBlock = Bcoin.getLastBlock();
      const previousBlockHash = lastBlock['hash'];
      const currentBlockData = {
          transactions: Bcoin.pendingTransactions,
          index: lastBlock['index'] + 1,

      };
      const reciet = Bcoin.PoW(previousBlockHash, currentBlockData);
      const nonce = reciet[0];
      const hash = Bcoin.hashBlock(previousBlockHash, currentBlockData, nonce);
      const newBlock = Bcoin.createNewBlock(nonce, previousBlockHash, hash);
      const requestPromises = [];
      Bcoin.networkNode.forEach(networkNodeUrl=>{
          const requestOptions = {
              uri: networkNodeUrl + '/receive-new-block',
              method: 'POST',
              body:{newBlock: newBlock},
              json: true
          };
          requestPromises.push(rp(requestOptions));
      });
      Promise.all(requestPromises).then(data=>{
          const requestOptions = {
              uri: Bcoin.currentNodeUrl + '/transaction/broadcast',
              method: 'POST',
              body: {
                  type: "g0ld",
                  data: 12.5,
                  sender: chainID,
                  recipient: nodeAddress,
              },
              json: true,

          };
          return rp(requestOptions);
      });
      
      res.json({
          "reciept":reciet, 
          "info":"A new block has been mined",
          "Block":newBlock,
      });
      Bcoin.createNewTransaction("g0ld", 12.5, chainID, nodeAddress );
      
});
  

// //end point to get a downloaded version of the code to run and connect to the blockchain
// app.get("/downloadCoin", function(req, res){
//     res.sendFile("initNode.txt",{root: __dirname});
// })

  

//recieve new block end point
//checks newly recieved block
app.post("/recieve-new-block",  function(req, res){
    const newBlock = req.body.newBlock;
    const lastBlock = Bcoin.getLastBlock();
    const correctHash = (lastBlock.hash === newBlock.previousBlockHash);
    const correctIndex = (lastBlock['index'] + 1 === newBlock.index);
    if(correctIndex & correctHash){
        Bcoin.chain.push(newBlock);
        res.json({
            note: "New block has been recieved and accepted",
            newBlock: newBlock,
        });
    }//end if
    else{
        res.json({
            note: "New block rejected",
            newBlock: newBlock,
            code:"AD00001",
            message: "Block is invalid"
        });
    }//end else
});


//register-and-broadcast-node end point
app.post("/register-and-broadcast-node", function(req, res){
    const newNodeUrl = req.body.newNodeUrl;//will be sending the new node that we want to add to our network.
    if(Bcoin.networkNode.indexOf(newNodeUrl) == -1){
        Bcoin.networkNode.push(newNodeUrl);
    }//end if
    const regNodesPromises = [];
    Bcoin.networkNode.forEach(networkNodeUrl => {
        //... register-node
        const requestOptions = {
            uri: networkNodeUrl + '/register-node',
            method: 'POST',
            body: {newNodeUrl: newNodeUrl},
            json: true,

        };
        regNodesPromises.push(rp(requestOptions));

    });
    Promise.all(regNodesPromises).then(data=>{
        const bulkRegisterOptions = {
            uri: newNodeUrl + '/register-nodes-bulk',
            method: 'POST',
            body: {allNetworkNodes: [...Bcoin.networkNode,Bcoin.currentNodeUrl]},
            json: true
        };
        return rp(bulkRegisterOptions).then(data =>{
            res.json({note: "New Node registered with network succesfully"});
        });
    });
});


/*** The difference between register-and-broadcast-node and register-node endpoint
* when we want to register a new node we go to register-and-broadcast
* then those nodes will register it on their node, and then submit the node to register-node
* 
*/


//register-node endpoint
app.post("/register-node", function(req, res){
    const newNodeUrl = req.body.newNodeUrl;
    const nodeNotAlreadyPresent = (Bcoin.networkNode.indexOf(newNodeUrl) == -1);
    const notCurrentNode = (Bcoin.currentNodeUrl !== newNodeUrl);
    if(nodeNotAlreadyPresent && notCurrentNode){
        Bcoin.networkNode.push(newNodeUrl);
    }//end if
    
    res.json({note: "New node registered succesfully."});
})


app.post("/register-nodes-bulk", function(req,res){
    const allNetNodes = req.body.allNetworkNodes;
    allNetNodes.forEach(networkNodeUrl =>{
        const nodeNotAlreadyPresent = (Bcoin.networkNode.indexOf(networkNodeUrl) == -1);
        const notCurrentNode = (Bcoin.currentNodeUrl !== networkNodeUrl);
        if(nodeNotAlreadyPresent && notCurrentNode){
            Bcoin.networkNode.push(networkNodeUrl);
        }//end if
    });
    res.json({note:"Bulk registration succesful"});
});


app.get("/consensus", function(req, res){
    
    const requestPromises = [];
    Bcoin.networkNode.forEach(networkNodeUrl =>{
        const requestOptions ={
            uri: networkNodeUrl + '/blockchain',
            method: 'GET',
            json: true,
        };
        requestPromises.push(rp(requestOptions));
    });
    Promise.all(requestPromises).then(blockchains =>{
        const currentChainLength = Bcoin.chain.length;
        let maxChainLength = currentChainLength;
        let newLongestChain = null;
        let newPendingTransactions = null;
        blockchains.forEach(blockchain =>{
            if(blockchain.chain.length > maxChainLength){
                maxChainLength = blockchain.chain.length;
                newLongestChain = blockchain.chain;
                newPendingTransactions = blockchain.pendingTransactions;
            };//end if
        });
        if(!newLongestChain || (newLongestChain && !Bcoin.chainIsValid(newLongestChain))){
            res.json({note: "Current chain has not been replaced",
                chain: Bcoin.chain,
            });

        }else{
            Bcoin.chain = newLongestChain;
            Bcoin.pendingTransactions = newPendingTransactions;
            res.json({
                note: "This chain has been replaced",
                chain: Bcoin.chain
            });
        }

    });
});




//  ********************************************************************************************
//  Block-Explorer Endpoints
//  ********************************************************************************************
// for searching and examining blocks



//returns matching :blockHash
app.get('/block/:blockHash', function(req, res){
    const blockHash = req.params.blockHash;
    const foundBlock = Bcoin.getBlock(blockHash);
    res.json({
        block: foundBlock,
    });
});


//returns matching :transactionId
app.get('/transaction/:transactionId', function(req, res){
    const transactionId = req.params.transactionId;
    const transactionData = Bcoin.getTransaction(transactionId);
    res.json({
        transaction: transactionData.transaction,
        block: transactionData.block,
    });

});


//returns matching :address
app.get('/address/:address', function(req, res){
    const address = req.params.address;
    const addressData = Bcoin.getAddressData(address);
    res.json({
        addressData: addressData
    });
});


//  ********************************************************************************************
//  Coin Explorer
//  ********************************************************************************************



//coin explorer
app.get("/bex",function(req, res){
    res.sendFile("./index.html", {root: __dirname});
});
  


//  ********************************************************************************************
//  JWT Token functions
//  ********************************************************************************************


function generateRefreshToken(loggedInUser){
    return jwt.sign(loggedInUser, process.env.REFRESH_TOKEN, {expiresIn: '3hr'})
}


function generateAuthenticationToken(loggedInUser){
    return jwt.sign(loggedInUser, process.env.ACCESS_TOKEN_SECRET, {expiresIn: '2hr'});
}


function authenticateToken(req, res, next){
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if(token == null){
        return res.sendStatus(403);
    }//end if
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, user)=>{
        if(err) {
            return sendStatus(403);
        }//end if
        req.user = user;
        next();
    });
}



//  Port determined by argsv[0]
//  Change this to something more friendly and secure, like a prompt or ""
//

//listen on port — HTTPS when DARM_TLS_CERT/DARM_TLS_KEY are provided, else HTTP.
if (process.env.DARM_TLS_CERT && process.env.DARM_TLS_KEY) {
    const https = require('https');
    const tlsOpts = { cert: fs.readFileSync(process.env.DARM_TLS_CERT), key: fs.readFileSync(process.env.DARM_TLS_KEY) };
    https.createServer(tlsOpts, app).listen(port, ()=>{
        console.log("Server is now listening on port (TLS)", port);
    });
} else {
    app.listen(port, ()=>{
        console.log("Server is now listening on port" ,port);
    });
}


// console.log('---------------------------Development envriornment node app starting----------------------');
