
//Elementary Random Primitives (ERPs) are the representation of distributions. They can have sampling, scoring, and support functions. A single ERP need not hve all three, but some inference functions will complain if they're missing one.
//The main thing we can do with ERPs in WebPPL is feed them into the "sample" primitive to get a sample. At top level we will also have some "inspection" functions to visualize them?
//
//erp.sample(params) returns a value sampled from the distribution.
//erp.score(params, val) returns the log-probability of val under the distribution.
//erp.support(params) gives an array of support elements.

function ERP(sampler, scorer, supporter) {
    this.sample = sampler
    this.score = scorer
    this.support = supporter
}

var bernoulli = new ERP(
                   function flipsample(params) {
                    var weight = params[0]
                    var val = Math.random() < weight
                    return val
                   },
                   function flipscore(params, val) {
                    var weight = params[0]
                    return val ? Math.log(weight) : Math.log(1-weight)
                   },
                   function flipsupport(params) {
                    return [true, false]
                   }
)

function multinomial_sample(theta)
{
	var k = theta.length
	var thetasum = 0
	for (var i = 0; i < k; i++) {thetasum += theta[i]}
	var x = Math.random() * thetasum
	var probAccum = 0
    for(var i=0; i<k; i++) {
        probAccum += theta[i]
        if(probAccum >= x) {return i} //FIXME: if x=0 returns i=0, but this isn't right if theta[0]==0...
    }
    return k
}



//Inference interface: an infrence function takes the current continuation and a WebPPL thunk (which itself has been transformed to take a continuation). It does some kind of inference and returns an ERP representing the nromalized marginal distribution on return values.
//The inference function should install a coroutine object that provides sample, factor, and exit.
//  sample and factor are the co-routine handlers: they get call/cc'ed from the wppl code to handle random stuff.
//  the inference function passes exit to the wppl fn, so that it gets called when the fn is exited, it can call the inference cc when inference is done to contintue the program.


//This global variable tracks the current coroutine, sample and factor use it to interface with the inference algorithm. Default setting throws an error on factor calls.
coroutine =
{
sample: function(cc, erp, params){cc(erp.sample(params))}, //sample and keep going
factor: function(){throw "factor allowed only inside inference."}
}

function sample(k, dist, params){coroutine.sample(k,dist, params)}
function factor(k, score){coroutine.factor(k,score)}


//////////////////
//Forward sampling: simply samples at each random choice. throws an error on factor, since we aren't doing any normalization / inference.
//TODO: can we abstract out the inference interface somewhat?
//TODO: i think we can make inference code ordinary functions, by having the constructor return with the value that exit finally returns...
function Forward(cc, wpplFn) {
    this.cc = cc
    
    //move old coroutine out of the way and install this as the current handler
    this.old_coroutine = coroutine
    coroutine = this
    
    //run the wppl computation, when the computation returns we want it to call the exit method of this coroutine so we pass that as the continuation (we wrap it up so that it gets called as a method, thus setting 'this' right).
    wpplFn(function(r){return coroutine.exit(r)})
    
    return this //constructor doesn't actually return until whole wppl program is done, because cc is called by exit...
}

Forward.prototype.sample = function(cc, erp, params) {
    cc(erp.sample(params)) //sample and keep going
}

Forward.prototype.factor = function(cc,score){throw "factor allowed only inside inference."}

Forward.prototype.exit = function(retval) {
    //put old coroutine back, and return the return value of the wppl fn as a delta erp, ignore scores for foward sampling...
    coroutine = this.old_coroutine
    dist=new ERP(function(){return retval}, function(p, v){return (v==retval)?0:-Infinity})
    this.cc(dist)
}


function fw(cc, wpplFn){return new Forward(cc, wpplFn)} //wrap with new call so that 'this' is set correctly..


//////////////////
// Enumeration: enumerate all the paths through the computation based on a priority queue.

function Enumerate(cc, wpplFn) {
    this.cc = cc
    this.score = 0 //used to track the score of the path currently being explored
    this.queue = [] //queue of continuations and values that we have yet to explore
    this.marginal = {} //used to build marginal
    
    //move old coroutine out of the way and install this as the current handler
    this.old_coroutine = coroutine
    coroutine = this
    
    //enter the wppl computation, when the computation returns we want it to call this.exit so we pass that as the continuation.
    wpplFn(function(r){return coroutine.exit(r)})
    
    return this //constructor doesn't actually return until whole wppl program is done, because cc is called by exit...
}

//the queue is a bunch of computation states. each state is a continuation, a value to apply it to, and a score.
Enumerate.prototype.nextInQueue = function() {
    
        var next_state = this.queue.pop()
        this.score = next_state.score
        next_state.continuation(next_state.value)
}

Enumerate.prototype.sample = function(cc, dist, params) {
    
    //find support of this erp:
    var supp = dist.support(params) //TODO: catch undefined support
    
    //for each value in support, add the continuation paired with support value and score to queue:
    for(var s in supp){
        var state = {continuation: cc,
                    value: supp[s],
                    score: this.score + dist.score(params, supp[s])}
        this.queue.push(state)
    }
    
    //call the next state on the queue
    this.nextInQueue()
}

Enumerate.prototype.factor = function(cc, score) {
    //update score and continue
    this.score += score
    cc()
}

Enumerate.prototype.exit = function(retval) {
    
    //have reached an exit of the computation. accumulate probability into retval bin.
    if(this.marginal[retval] == undefined){this.marginal[retval]=0}
    this.marginal[retval] += Math.exp(this.score)
    
    //if anything is left in queue do it:
    if(this.queue.length > 0){
        this.nextInQueue()
    } else {
        //reinstate previous coroutine:
        coroutine = this.old_coroutine
        //normalize distribution:
        var norm=0, supp=[]
        var marginal = this.marginal
        for(var v in marginal){norm+=marginal[v];supp.push(v)}
        for(var v in marginal){marginal[v]=marginal[v]/norm}
        console.log("Enumerated distribution: ")
        console.log(marginal)
        //make an ERP from marginal:
        var dist = new ERP(function(params){
                           var k = marginal.length
                           var x = Math.random()
                           var probAccum = 0
                           for(var i in marginal) {
                            probAccum += marginal[i]
                            if(probAccum >= x) {return i} //FIXME: if x=0 returns i=0, but this isn't right if theta[0]==0...
                           }
                           return i},
                           function(params,val){return marginal[val]},
                           function(params){return supp})
        //return from enumeration by calling original continuation:
        this.cc(dist)
    }
}

function enu(cc, wpplFn){return new Enumerate(cc, wpplFn)} //wrap with new call so that 'this' is set correctly..

function multinomial_sample_normed(theta)
{
	var k = theta.length
	var x = Math.random() //assumes normalized theta vector
	var probAccum = 0
    for(var i=0; i<k; i++) {
        probAccum += theta[i]
        if(probAccum >= x) {return i} //FIXME: if x=0 returns i=0, but this isn't right if theta[0]==0...
    }
    return k
}

//////////////////
// particle filtering


//////////////////
//some primitive functions to make things simpler

function display(k,x){k(console.log(x))}

function callPrimitive(k,f){
    var args = Array.prototype.slice.call(arguments,2)
    k(f.apply(f,args))
}

function plus(k, x, y) {k(x + y)};
function minus(k, x, y) {k(x - y)};
function times(k, x, y) {k(x * y)};
function and(k, x, y) {k(x && y)};


module.exports = {
ERP: ERP,
bernoulli: bernoulli,
fw: fw,
enu: enu,
//coroutine: coroutine,
sample: sample,
factor: factor,
display: display,
callPrimitive: callPrimitive,
plus: plus,
minus: minus,
times: times,
and: and
}