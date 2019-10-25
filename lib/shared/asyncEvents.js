/*
 * @package jsDAV
 * @subpackage shared
 * @copyright Copyright(c) 2011 Ajax.org B.V. <info AT ajax DOT org>
 * @author Mike de Boer <info AT mikedeboer DOT nl>
 * @license http://github.com/mikedeboer/jsDAV/blob/master/LICENSE MIT License
 */
"use strict";

var jsDAV = require("./../jsdav");

var Util = require("./util");
var Async = require("asyncjs");

exports.EventEmitter = function() {};

exports.EventEmitter.DEFAULT_TIMEOUT = 30000; // in milliseconds
exports.EventEmitter.PRIO_LOW    = 0x0001;
exports.EventEmitter.PRIO_NORMAL = 0x0002;
exports.EventEmitter.PRIO_HIGH   = 0x0004;

var _slice = Array.prototype.slice;

async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
}

(function() {
    var _ev = exports.EventEmitter;

    function persistRegistry() {
        if (this.$eventRegistry)
            return;
        this.$eventRegistry = {};
        this.$eventRegistry[_ev.PRIO_LOW]    = {};
        this.$eventRegistry[_ev.PRIO_NORMAL] = {};
        this.$eventRegistry[_ev.PRIO_HIGH]   = {};
    }

    function getListeners(eventName) {
        return (this.$eventRegistry[_ev.PRIO_HIGH][eventName] || []).concat(
            this.$eventRegistry[_ev.PRIO_NORMAL][eventName] || []).concat(
            this.$eventRegistry[_ev.PRIO_LOW][eventName] || []);
    }

    this.dispatchEvent = async function() {
        persistRegistry.call(this);

        var returnValue = null,
            args        = _slice.call(arguments),
            eventName   = args.shift().toLowerCase(),
            listeners   = getListeners.call(this, eventName)

//        console.log("Dispatching:", eventName, args, listeners.length)

        if (!listeners.length)
            return

        await asyncForEach(listeners, async (listener) => {
            await listeners[0].apply(null, [].concat(args));
        })
//        console.log("Done Dispatching:", eventName)
        return returnValue
    };

    this.addEventListener = function(eventName, listener, prio, timeout) {
        persistRegistry.call(this);

        // disable timeouts while debugging
        if (jsDAV.debugMode)
            timeout = false;
        listener.$usetimeout = timeout === false
            ? 0
            : (typeof timeout == "number")
                ? timeout
                : exports.EventEmitter.DEFAULT_TIMEOUT;

        eventName = eventName.toLowerCase();
        prio = prio || _ev.PRIO_NORMAL;
        var allListeners = getListeners.call(this, eventName);
        var listeners = this.$eventRegistry[prio][eventName];
        if (!listeners)
            listeners = this.$eventRegistry[prio][eventName] = [];
        if (allListeners.indexOf(listener) === -1)
            listeners.push(listener);
    };

    this.removeEventListener = function(eventName, listener) {
        persistRegistry.call(this);

        eventName = eventName.toLowerCase();
        var _self = this;
        [_ev.PRIO_LOW, _ev.PRIO_NORMAL, _ev.PRIO_HIGH].forEach(function(prio) {
            var listeners = _self.$eventRegistry[prio][eventName];
            if (!listeners)
                return;
            var index = listeners.indexOf(listener);
            if (index !== -1)
                listeners.splice(index, 1);
        });
    };
}).call(exports.EventEmitter.prototype);
