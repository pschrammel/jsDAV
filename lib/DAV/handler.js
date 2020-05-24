/*
 * @package jsDAV
 * @subpackage DAV
 * @copyright Copyright(c) 2011 Ajax.org B.V. <info AT ajax DOT org>
 * @author Mike de Boer <info AT mikedeboer DOT nl>
 * @license http://github.com/mikedeboer/jsDAV/blob/master/LICENSE MIT License
 */
"use strict";

// DAV classes used directly by the Handler object
var jsDAV = require("./../jsdav");
var jsDAV_Server = require("./server");
var jsDAV_Property_Response = require("./property/response");
var jsDAV_Property_GetLastModified = require("./property/getLastModified");
var jsDAV_Property_ResourceType = require("./property/resourceType");
var jsDAV_Property_SupportedReportSet = require("./property/supportedReportSet");
// interfaces to check for:
var jsDAV_iFile = require("./interfaces/iFile");
var jsDAV_iCollection = require("./interfaces/iCollection");
var jsDAV_iExtendedCollection = require("./interfaces/iExtendedCollection")
var jsDAV_iQuota = require("./interfaces/iQuota");
var jsDAV_iProperties = require("./interfaces/iProperties");

var Url = require("url");
var Fs = require("fs");
var Path = require("path");
var AsyncEventEmitter = require("./../shared/asyncEvents").EventEmitter;
var Exc = require("./../shared/exceptions");
var Util = require("./../shared/util");
var Xml = require("./../shared/xml");
var Async = require("asyncjs");
var Formidable = require("formidable");

var requestCounter = 0;

/**
 * Called when an http request comes in, pass it on to invoke and handle any
 * exceptions that might be thrown
 *
 * @param {jsDav_Server}   server
 * @param {ServerRequest}  req
 * @param {ServerResponse} resp
 * @return {jsDAV_Handler}
 */
var jsDAV_Handler = module.exports = function(server, req, resp) {
    this.server       = server;
    this.httpRequest  = Util.streamBuffer(req);
    this.httpResponse = resp;
    this.plugins      = {};

    for (var plugin in server.plugins) {
        if (typeof server.plugins[plugin] != "object")
            continue;
        this.plugins[plugin] = server.plugins[plugin].new(this);
    }
    this.tree=this.server.tree.new(this)
    this.invoke().
        then(() => {}).
        catch((ex) => {
            this.handleError(ex);
    })
};

/**
 * Inifinity is used for some request supporting the HTTP Depth header and indicates
 * that the operation should traverse the entire tree
 */
jsDAV_Handler.DEPTH_INFINITY = -1;

/**
 * Nodes that are files, should have this as the type property
 */
jsDAV_Handler.NODE_FILE      = 1;

/**
 * Nodes that are directories, should use this value as the type property
 */
jsDAV_Handler.NODE_DIRECTORY = 2;

jsDAV_Handler.PROP_SET       = 1;
jsDAV_Handler.PROP_REMOVE    = 2;

jsDAV_Handler.STATUS_MAP     = {
    "100": "Continue",
    "101": "Switching Protocols",
    "200": "OK",
    "201": "Created",
    "202": "Accepted",
    "203": "Non-Authorative Information",
    "204": "No Content",
    "205": "Reset Content",
    "206": "Partial Content",
    "207": "Multi-Status", // RFC 4918
    "208": "Already Reported", // RFC 5842
    "300": "Multiple Choices",
    "301": "Moved Permanently",
    "302": "Found",
    "303": "See Other",
    "304": "Not Modified",
    "305": "Use Proxy",
    "307": "Temporary Redirect",
    "400": "Bad request",
    "401": "Unauthorized",
    "402": "Payment Required",
    "403": "Forbidden",
    "404": "Not Found",
    "405": "Method Not Allowed",
    "406": "Not Acceptable",
    "407": "Proxy Authentication Required",
    "408": "Request Timeout",
    "409": "Conflict",
    "410": "Gone",
    "411": "Length Required",
    "412": "Precondition failed",
    "413": "Request Entity Too Large",
    "414": "Request-URI Too Long",
    "415": "Unsupported Media Type",
    "416": "Requested Range Not Satisfiable",
    "417": "Expectation Failed",
    "418": "I'm a teapot", // RFC 2324
    "422": "Unprocessable Entity", // RFC 4918
    "423": "Locked", // RFC 4918
    "424": "Failed Dependency", // RFC 4918
    "500": "Internal Server Error",
    "501": "Not Implemented",
    "502": "Bad Gateway",
    "503": "Service Unavailable",
    "504": "Gateway Timeout",
    "505": "HTTP Version not supported",
    "507": "Unsufficient Storage", // RFC 4918
    "508": "Loop Detected" // RFC 5842
};

(function() {
    /**
     * httpResponse
     *
     * @var HTTP_Response
     */
    this.httpResponse =

    /**
     * httpRequest
     *
     * @var HTTP_Request
     */
    this.httpRequest = null;

    /**
     * The propertymap can be used to map properties from
     * requests to property classes.
     *
     * @var array
     */
    this.propertyMap = {
        "{DAV:}resourcetype": jsDAV_Property_ResourceType
    };

    this.protectedProperties = [
        // RFC4918
        "{DAV:}getcontentlength",
        "{DAV:}getetag",
        "{DAV:}getlastmodified",
        "{DAV:}lockdiscovery",
        "{DAV:}resourcetype",
        "{DAV:}supportedlock",

        // RFC4331
        "{DAV:}quota-available-bytes",
        "{DAV:}quota-used-bytes",

        // RFC3744
        "{DAV:}alternate-URI-set",
        "{DAV:}principal-URL",
        "{DAV:}group-membership",
        "{DAV:}supported-privilege-set",
        "{DAV:}current-user-privilege-set",
        "{DAV:}acl",
        "{DAV:}acl-restrictions",
        "{DAV:}inherited-acl-set",
        "{DAV:}principal-collection-set",

        // RFC5397
        "{DAV:}current-user-principal"
    ];

    /**
     * This property allows you to automatically add the 'resourcetype' value
     * based on a node's classname or interface.
     *
     * The preset ensures that {DAV:}collection is automaticlly added for nodes
     * implementing jsDAV_iCollection.
     *
     * @var object
     */
    this.resourceTypeMapping = {
        "{DAV:}collection": jsDAV_iCollection
    };

    var internalMethods = {
        "OPTIONS":1,
        "GET":1,
        "HEAD":1,
        "DELETE":1,
        "PROPFIND":1,
        "MKCOL":1,
        "PUT":1,
        "PROPPATCH":1,
        "COPY":1,
        "MOVE":1,
        "REPORT":1
    };

    /**
     * Handles a http request, and execute a method based on its name
     *
     * @return void
     */
    this.invoke = async function() {
        var method = this.httpRequest.method.toUpperCase(),
            self  = this;
        if (jsDAV.debugMode) {
            this.id = ++requestCounter;
//            Util.log("{" + this.id + "}", method, this.httpRequest.url);
//            Util.log("{" + this.id + "}", this.httpRequest.headers);
            var wh = this.httpResponse.writeHead,
                we = this.httpResponse.end;
            this.httpResponse.writeHead = function(code, headers) {
//                Util.log("{" + self.id + "}", code, headers);
                this.writeHead = wh;
                this.writeHead(code, headers);
            };
            this.httpResponse.end = function(content) {
//                Util.log("{" + self.id + "}", "'" + (content || "") + "'");
                this.end = we;
                this.end(content);
            };
        }

        var uri = this.getRequestUri();
        await this.dispatchEvent("beforeMethod", method, uri)
//        console.log("CALLING:", method, uri) //, this.httpRequest.headers)
        if (internalMethods[method]) {
            await this["http" + method.charAt(0) + method.toLowerCase().substr(1)]();
        } else {
            throw(new Exc.NotImplemented())
        }
    };

    /**
     * Centralized error and exception handler, which constructs a proper WebDAV
     * 500 server error, or different depending on the error object implementation
     * and/ or extensions.
     *
     * @param  {Error} e Error string or Exception object
     * @return {void}
     */
    this.handleError = function(e) {
        //if (jsDAV.debugMode)
        //    console.trace();
        if (e === true)
            return; // plugins should return TRUE to prevent error reporting.
        if (typeof e == "string")
            e = new Exc.jsDAV_Exception(e);
        if (typeof e == 'undefined')
            e = new Exc.jsDAV_Exception('undefined error')

        //console.error("handleError",e,console.trace())
        var xml = '<?xml version="1.0" encoding="utf-8"?>\n'
                + '<d:error xmlns:d="DAV:" xmlns:a="' + Xml.NS_AJAXORG + '">\n'
                + '    <a:exception>' + (e.type || e.toString()) + '</a:exception>\n'
                + '    <a:message>'   + e.message + '</a:message>\n';
        if (this.server.debugExceptions) {
            xml += '<a:file>' + (e.filename || "") + '</a:file>\n'
                +  '<a:line>' + (e.line || "") + '</a:line>\n';
        }
        xml += '<a:jsdav-version>' + jsDAV_Server.VERSION + '</a:jsdav-version>\n';

        var code = 500;
        var self = this;
        if (e instanceof Exc.jsDAV_Exception) {
            code = e.code;
            xml  = e.serialize(this, xml);
            e.getHTTPHeaders(this, function(err, h) {
                afterHeaders(h);
            });
        }
        else {
            afterHeaders({});
        }

        function afterHeaders(headers) {
            headers["Content-Type"] = "application/xml; charset=utf-8";
//            console.log("writing", code)
            self.httpResponse.writeHead(code, headers);
            self.httpResponse.end(xml + '</d:error>', "utf-8");

            if (jsDAV.debugMode) {
                Util.log(e, "error");
//                console.log(e.stack);
                //throw e; // DEBUGGING!
            }
        }
    };

    this.asyncGetNodeForPath = async function(path, noThrowError) {
        var node;

        try {
            node = await this.tree.getNodeForPath(path)
        } catch(err) {
            if (!noThrowError  || err.type != 'FileNotFound') {
                throw(err)
            }
        }
        return node;
    };


    /**
     * HTTP OPTIONS
     *
     * @return {void}
     * @throws {Error}
     */
    this.httpOptions = async function() {
        var uri  = this.getRequestUri();
        var methods = [
            "OPTIONS",
            "GET",
            "HEAD",
            "DELETE",
            "PROPFIND",
            "PUT",
            "PROPPATCH",
            "COPY",
            "MOVE",
            "REPORT"
        ];

        // The MKCOL is only allowed on an unmapped uri
        var node = await this.asyncGetNodeForPath(uri)
        methods.push("MKCOL");

        // We're also checking if any of the plugins register any new methods
        for (var plugin in this.plugins) {
            if (!this.plugins[plugin].getHTTPMethods)
                Util.log("method getHTTPMethods() NOT implemented for plugin " + plugin, "error");
            else
                methods = methods.concat(this.plugins[plugin].getHTTPMethods(uri, node));
        }

        var headers = {
            "Allow": Util.makeUnique(methods).join(",").toUpperCase(),
            "Access-Control-Allow-Origin": '*',
            "Access-Control-Allow-Methods": '*',
            "MS-Author-Via"   : "DAV",
            "Accept-Ranges"   : "bytes",
            "X-jsDAV-Version" : jsDAV_Server.VERSION,
            "Content-Length"  : 0
        };

        var features = ["1", "3", "extended-mkcol"];

        for (var plugin in this.plugins) {
            if (!this.plugins[plugin].getFeatures)
                Util.log("method getFeatures() NOT implemented for plugin " + plugin, "error");
            else
                features = features.concat(this.plugins[plugin].getFeatures());
        }

        headers["DAV"] = features.join(",");

        this.httpResponse.writeHead(200, headers);
        this.httpResponse.end();
    };

    /**
     * HTTP GET
     *
     * This method simply fetches the contents of a uri, like normal
     *
     * @return {void}
     * @throws {Error}
     */
    this.httpGet = async function() {
        var uri  = this.getRequestUri();
        var node = await this.asyncGetNodeForPath(uri,true)
        var redirected = await this.checkPreconditions(node, true)

        if (redirected)
            return;
        if (!node)
            throw(new Exc.FileNotFound(`File at location ${uri} not found`))


        if (!node.hasFeature(jsDAV_iFile)) {
            throw(new Exc.NotImplemented(
                    "GET is only implemented on File objects"));
        }

        var httpHeaders=await this.asyncGetHTTPHeaders(uri)
        //            console.log("got headers");

        var nodeSize = null;
        // ContentType needs to get a default, because many webservers
        // will otherwise default to text/html, and we don't want this
        // for security reasons.
        if (!httpHeaders["content-type"])
            httpHeaders["content-type"] = "application/octet-stream";

        if (httpHeaders["content-length"]) {
            nodeSize = httpHeaders["content-length"];
            // Need to unset Content-Length, because we'll handle that
            // during figuring out the range
            delete httpHeaders["content-length"];
        }

        var range             = this.getHTTPRange();
        var ifRange           = this.httpRequest.headers["if-range"];
        var ignoreRangeHeader = false;
        //            console.log("headers", range, ifRange, ignoreRangeHeader);

        // If ifRange is set, and range is specified, we first need
        // to check the precondition.
        if (nodeSize && range && ifRange) {
            // if IfRange is parsable as a date we'll treat it as a
            // DateTime otherwise, we must treat it as an etag.
            try {
                var ifRangeDate = new Date(ifRange);

                // It's a date. We must check if the entity is modified
                // since the specified date.
                if (!httpHeaders["last-modified"]) {
                    ignoreRangeHeader = true;
                }
                else {
                    var modified = new Date(httpHeaders["last-modified"]);
                    if (modified > ifRangeDate)
                        ignoreRangeHeader = true;
                }
            }
            catch (ex) {
                // It's an entity. We can do a simple comparison.
                if (!httpHeaders["etag"])
                        ignoreRangeHeader = true;
                else if (httpHeaders["etag"] !== ifRange)
                    ignoreRangeHeader = true;
            }
        }

        // We're only going to support HTTP ranges if the backend
        // provided a filesize
        if (!ignoreRangeHeader && nodeSize && range) {
            // Determining the exact byte offsets
            var start, end;
            if (range[0] !== null) {
                start = range[0];
                // the browser/ client sends 'end' offsets as factor of nodeSize - 1,
                // so we need to correct it, because NodeJS streams byte offsets
                // are inclusive
                end   = range[1] !== null ? range[1] + 1 : nodeSize;
                if (start > nodeSize) {
                    throw(new Exc.RequestedRangeNotSatisfiable(
                        "The start offset (" + range[0] + ") exceeded the size of the entity ("
                            + nodeSize + ")")
                         );
                }

                if (end < start) {
                    throw(new Exc.RequestedRangeNotSatisfiable(
                        "The end offset (" + range[1] + ") is lower than the start offset ("
                            + range[0] + ")")
                         );
                }
                if (end > nodeSize)
                    end = nodeSize;

            }
            else {
                start = nodeSize - range[1];
                end   = nodeSize;
                if (start < 0)
                    start = 0;
            }

            var offlen = end - start;
            // Prevent buffer error
            // https://github.com/joyent/node/blob/v0.4.5/lib/buffer.js#L337
            if (end < start) {
                var swapTmp = end;
                end = start;
                start = swapTmp;
            }

            // report a different end offset, corrected by 1:
            var clientEnd = end > 0 ? end - 1 : end;
            httpHeaders["content-length"] = offlen;
            httpHeaders["content-range"]  = "bytes " + start + "-" + clientEnd + "/" + nodeSize;
            //                console.log("going upstream 1");
            await this.downStream(node,start,end,httpHeaders)
        } else {
            var since        = this.httpRequest.headers["if-modified-since"];
            var oldEtag      = this.httpRequest.headers["if-none-match"];
            var lastModified = httpHeaders["last-modified"];
            var etag         = httpHeaders["etag"];
            since = since && Date.parse(since).valueOf();
            lastModified = lastModified && Date.parse(lastModified).valueOf();
            // If there is no match, then move on.
            if (!((since && lastModified === since) || (etag && oldEtag === etag))) {
                if (nodeSize)
                    httpHeaders["content-length"] = nodeSize;
                //                    console.log("going upstream 2");
                await this.downStream(node,start,end,httpHeaders)
            } else {
                // Filter out any Content based headers since there
                // is no content.
                var newHeaders = {};
                Object.keys(httpHeaders).forEach(function(key) {
                    if (key.indexOf("content") < 0)
                        newHeaders[key] = httpHeaders[key];
                });
                //                    console.log("304");
                this.httpResponse.writeHead(304, newHeaders);
                this.httpResponse.end();
            }
        }

    };

    this.downStream = async function(node,start,end,httpHeaders) {
        var writeStreamingHeader = function () {
            self.httpResponse.writeHead(200, httpHeaders);
        };
        var self = this;
        var stream = await this.tree.readFile(node,start, end)

         self.httpResponse.on("drain", function() {
             stream.resume()
         })

        stream.on("data", function(data) {
            if (writeStreamingHeader) {
                writeStreamingHeader();
                writeStreamingHeader = null;
            }
            if (self.httpResponse.write(data)) {
            } else {
                stream.pause()
            }
        });

        stream.on("error", function(err) {
            if (!writeStreamingHeader) {
                self.httpResponse.end();
            } else {
                throw(err)
            }
        })

        stream.on("end", function() {
            self.httpResponse.end();
        });
    }
    /**
     * HTTP HEAD
     *
     * This method is normally used to take a peak at a url, and only get the
     * HTTP response headers, without the body.
     * This is used by clients to determine if a remote file was changed, so
     * they can use a local cached version, instead of downloading it again
     *
     * @return {void}
     * @throws {Error}
     */
    this.httpHead = async function() {
        var uri   = this.getRequestUri()
        var node = await this.asyncGetNodeForPath(uri)

        /* This information is only collection for File objects.
         * Ideally we want to throw 405 Method Not Allowed for every
         * non-file, but MS Office does not like this
         */
        if (node.hasFeature(jsDAV_iFile)) {
//            console.log("HEAD for file")
            var headers = this.asyncGetHTTPHeaders(uri)
            if (!headers["content-type"])
                headers["content-type"] = "application/octet-stream";
            headers["content-length"]=0
            this.httpResponse.writeHead(200, headers);
            this.httpResponse.end();
            return true
        } else {
//            console.log("HEAD for non file")
            return false
        }
    };

    /**
     * HTTP Delete
     *
     * The HTTP delete method, deletes a given uri
     *
     * @return {void}
     * @throws {Error}
     */
    this.httpDelete = async function() {
        var uri  = this.getRequestUri();
        var node = await this.asyncGetNodeForPath(uri)
        await this.tree["delete"](node)
        this.httpResponse.writeHead(204, {"content-length": "0"});
        this.httpResponse.end();
    };

    /**
     * WebDAV PROPFIND
     *
     * This WebDAV method requests information about an uri resource, or a list
     * of resources
     * If a client wants to receive the properties for a single resource it will
     * add an HTTP Depth: header with a 0 value.
     * If the value is 1, it means that it also expects a list of sub-resources
     * (e.g.: files in a directory)
     *
     * The request body contains an XML data structure that has a list of
     * properties the client understands.
     * The response body is also an xml document, containing information about
     * every uri resource and the requested properties
     *
     * It has to return a HTTP 207 Multi-status status code
     *
     * @throws {Error}
     */
    this.httpPropfind = async function() {
        var xmlData = await this.getXMLBody()
//        console.log("XML request:", xmlData)
        var requestedProperties = await this.parsePropfindRequest(xmlData)
        var depth = this.getHTTPDepth(1);
        // The only two options for the depth of a propfind is 0 or 1
        if (depth !== 0)
            depth = 1;

        // The requested path
        var path;
        path = this.getRequestUri();
        var newProperties= await this.asyncGetPropertiesForPath(path, requestedProperties, depth)

        // Normally this header is only needed for OPTIONS responses, however..
        // iCal seems to also depend on these being set for PROPFIND. Since
        // this is not harmful, we'll add it.
        var features = ["1", "3", "extended-mkcol"];

        for (var plugin in this.plugins) {
            if (!this.plugins[plugin].getFeatures)
                Util.log("method getFeatures() NOT implemented for plugin " + plugin, "error");
            else
                features = features.concat(this.plugins[plugin].getFeatures());
        }

        // This is a multi-status response.
        this.httpResponse.writeHead(207, {
            "content-type": "application/xml; charset=utf-8",
            "vary": "Brief,Prefer",
            "DAV": features.join(",")
        });
        var prefer = this.getHTTPPrefer();
        this.httpResponse.end(this.generateMultiStatus(newProperties, prefer["return-minimal"]));
    };

    /**
     * WebDAV PROPPATCH
     *
     * This method is called to update properties on a Node. The request is an
     * XML body with all the mutations.
     * In this XML body it is specified which properties should be set/updated
     * and/or deleted
     *
     * @return {void}
     */
    this.httpProppatch = async function() {
        var xmlData = await this.getXMLBody()
        var newProperties = await this.parseProppatchRequest(xmlData)
        var uri = this.getRequestUri()
        var result = await this.updateProperties(uri, newProperties)
        var prefer = this.getHTTPPrefer();
        if (prefer["return-minimal"]) {
            // If return-minimal is specified, we only have to check if the
            // request was succesful, and don't need to return the
            // multi-status.
            var prop;
            var ok = true;
            for (var code in result) {
                prop = result[code];
                if (parseInt(code, 10) > 299) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                this.httpResponse.writeHead(204, {
                    "vary": "Brief, Prefer"
                });
                this.httpResponse.end();
                return;
            }
        }

        this.httpResponse.writeHead(207, {
            "content-type": "application/xml; charset=utf-8",
            "vary": "Brief, Prefer"
        });
        this.httpResponse.end(this.generateMultiStatus(result));
    };

    /**
     * HTTP PUT method
     *
     * This HTTP method updates a file, or creates a new one.
     * If a new resource was created, a 201 Created status code should be returned.
     * If an existing resource is updated, it's a 200 Ok
     *
     * @return {void}
     */
    this.httpPut = async function() {
        var uri  = this.getRequestUri();
        // Intercepting Content-Range
        if (this.httpRequest.headers["content-range"]) {
            /*
            Content-Range is dangerous for PUT requests:  PUT per definition
            stores a full resource.  draft-ietf-httpbis-p2-semantics-15 says
            in section 7.6:
              An origin server SHOULD reject any PUT request that contains a
              Content-Range header field, since it might be misinterpreted as
              partial content (or might be partial content that is being mistakenly
              PUT as a full representation).  Partial content updates are possible
              by targeting a separately identified resource with state that
              overlaps a portion of the larger resource, or by using a different
              method that has been specifically defined for partial updates (for
              example, the PATCH method defined in [RFC5789]).
            This clarifies RFC2616 section 9.6:
              The recipient of the entity MUST NOT ignore any Content-*
              (e.g. Content-Range) headers that it does not understand or implement
              and MUST return a 501 (Not Implemented) response in such cases.
            OTOH is a PUT request with a Content-Range currently the only way to
            continue an aborted upload request and is supported by curl, mod_dav,
            Tomcat and others.  Since some clients do use this feature which results
            in unexpected behaviour (cf PEAR::HTTP_WebDAV_Client 1.0.1), we reject
            all PUT requests with a Content-Range for now.
            */

            throw(new Exc.NotImplemented("PUT with Content-Range is not allowed."));
        }

        // First we'll do a check to see if the resource already exists
        var node = await this.asyncGetNodeForPath(uri,true)
        if (node) {
            // Checking If-None-Match and related headers.
            var redirected = await this.checkPreconditions(node,false)
            if (redirected) {
                console.log("redirected")
                return false;
            }
            if (!node.hasFeature(jsDAV_iFile)) // If the node is a collection, we'll deny it
                throw(new Exc.Conflict("PUT is not allowed on non-files."));
            var resp = await this.tree.writeFile(parent,name, node)
            await this.upStream(resp.stream);
            var headers = {"content-length": "0"};

            headers.etag = node.getETag();
            this.httpResponse.writeHead(201, headers);
            this.httpResponse.end();
        } else {
            // If we got here, the resource didn't exist yet.
            // `data` is set to `null` to use streamed write.
            var parts = Util.splitPath(uri);
            var dir   = parts[0];
            var name  = parts[1];
            var parent = await this.asyncGetNodeForPath(dir)
            var resp = await this.tree.writeFile(parent, name, null)
            await this.upStream(resp.stream);
            var headers = {"content-length": "0"};
            headers.etag = resp.node.getETag();
            this.httpResponse.writeHead(201, headers);
            this.httpResponse.end();



        }
    };

    this.upStream = async function(stream) {
        var req = this.httpRequest;
        var contentLength = req.headers["content-length"];

        var buff = [];
        var contentLength = req.headers["content-length"];
        var lengthCount = 0;
        var promise = new Promise((resolve, reject) => {

            stream.on("error", function(ex) { reject(err) });

            req.streambuffer.ondata(function(data) {
                lengthCount += data.length;
                stream.write(data);
            });

            req.streambuffer.onend(function() {
                // TODO: content-length check and rollback...
                stream.on("close", function() {
                    if (contentLength && parseInt(contentLength, 10) != lengthCount) {
                        reject(new Exc.BadRequest("Content-Length mismatch: Request Header claimed "
                                                  + contentLength + " bytes, but received " + lengthCount + " bytes"));
                    } else {
                        resolve()
                    }
                });
                stream.end();
            })

        })
        req.resume();
        return promise
    }
    /**
     * WebDAV MKCOL
     *
     * The MKCOL method is used to create a new collection (directory) on the server
     *
     * @return {void}
     */
    this.httpMkcol = async function() {
        var resourceType;
        var properties = {};
        var req        = this.httpRequest;

        var requestBody = await this.getXMLBody()
        if (requestBody) {
            var contentType = req.headers["content-type"];
            if (contentType.indexOf("application/xml") !== 0 && contentType.indexOf("text/xml") !== 0) {
                // We must throw 415 for unsupported mkcol bodies
                throw(new Exc.UnsupportedMediaType("The request body for the MKCOL request must have an xml Content-Type"))

            }

            var dom = await Xml.loadDOMDocument(requestBody, this.server.options.parser)
            var firstChild = dom.firstChild;

            if (Xml.toClarkNotation(firstChild) !== "{DAV:}mkcol") {
                // We must throw 415 for unsupport mkcol bodies
                throw(new Exc.UnsupportedMediaType(
                            "The request body for the MKCOL request must be a {DAV:}mkcol request construct."));
            }

            var childNode;
            var i = 0;
            var c = firstChild.childNodes;
            var l = c.length;
            for (; i < l; ++i) {
                childNode = c[i];
                if (Xml.toClarkNotation(childNode) !== "{DAV:}set")
                    continue;
                properties = Util.extend(properties, Xml.parseProperties(childNode, this.propertyMap));
            }

            if (!properties["{DAV:}resourcetype"]) {
                throw(new Exc.BadRequest(
                    "The mkcol request must include a {DAV:}resourcetype property")
                     );
            }

            delete properties["{DAV:}resourcetype"];

            resourceType = [];
            // Need to parse out all the resourcetypes
            var rtNode = firstChild.getElementsByTagNameNS("urn:DAV", "resourcetype")[0];
            for (i = 0, c = rtNode.childNodes, l = c.length; i < l; ++i)
                resourceType.push(Xml.toClarkNotation(c[i]));
        } else {
            resourceType = ["{DAV:}collection"];
        }


        var uri = this.getRequestUri()
        var result = await this.createCollection(uri, resourceType, properties)
        if (result && result.length) {
            this.httpResponse.writeHead(207, {"content-type": "application/xml; charset=utf-8"});
            this.httpResponse.end(this.generateMultiStatus(result));
        } else {
            this.httpResponse.writeHead(201, {"content-length": "0"});
            this.httpResponse.end();
        }
    };

    /**
     * WebDAV HTTP MOVE method
     *
     * This method moves one uri to a different uri. A lot of the actual request
     * processing is done in getCopyMoveInfo
     *
     * @return {void}
     */
    this.httpMove = async function() {
        var moveInfo = await this.getCopyAndMoveInfo()
        if (moveInfo.destinationExists)
            await moveInfo.destinationNode["delete"]()
        await this.tree.move(moveInfo)
        // If a resource was overwritten we should send a 204, otherwise a 201
        this.httpResponse.writeHead(moveInfo.destinationExists ? 204 : 201,
                                    {"content-length": "0"});
        this.httpResponse.end();
    };

    /**
     * WebDAV HTTP COPY method
     *
     * This method copies one uri to a different uri, and works much like the MOVE request
     * A lot of the actual request processing is done in getCopyMoveInfo
     *
     * @return {void}
     */
    this.httpCopy = async function() {
        var copyInfo = await this.getCopyAndMoveInfo()
        if (copyInfo.destinationExists)
            await copyInfo.destinationNode["delete"]()

        await this.tree.copy(copyInfo)
        // If a resource was overwritten we should send a 204, otherwise a 201
        this.httpResponse.writeHead(copyInfo.destinationExists ? 204 : 201,
                                    {"Content-Length": "0"});
        this.httpResponse.end();
    };

    /**
     * HTTP REPORT method implementation
     *
     * Although the REPORT method is not part of the standard WebDAV spec (it's from rfc3253)
     * It's used in a lot of extensions, so it made sense to implement it into the core.
     *
     * @return {void}
     */
    this.httpReport = async function() {
        var requestBody = await this.getXMLBody()
        var dom = await Xml.loadDOMDocument(requestBody, this.server.options.parser)
        var reportName = Xml.toClarkNotation(dom);
        throw(new Exc.ReportNotImplemented());
    };

    /**
     * Gets the uri for the request, keeping the base uri into consideration
     *
     * @return {String}
     * @throws {Error}
     */
    this.getRequestUri = function() {
        return this.calculateUri(this.httpRequest.url);
    };


    /**
     * Fetch the binary data for the HTTP request and return it to a callback OR
     * write it to a WritableStream instance.
     *
     * @param  {String} enc
     * @param  {WritableStream} [stream]
     * @param  {Boolean} [forceStream]
     * @param  {Function} callback
     * @return {void}
     */
    this.getXMLBody = function() {
        var form = new Formidable.IncomingForm();
        var req = this.httpRequest;
        //Formidable will only parse when we have the right content type
        req.headers['content-type']='application/octet-stream'

        var promise = new Promise((resolve,reject) => {
            form.on("error", function(err) {
                reject(err)
            });

            form.parse(req, function(err, fields, files) {
//                console.log("parsed", fields, files.file)
                if (files && files.file) {
                    Fs.readFile(files.file.path, function(err, data) {
                        resolve(data.toString('utf8'));
                        Fs.unlink(files.file.path,function() {});
                    })
                } else {
                    resolve(null)
                }

            });
        });
        req.resume();
        return promise;
    };


    /**
     * Calculates the uri for a request, making sure that the base uri is stripped out
     *
     * @param  {String} uri
     * @throws {Exc.Forbidden} A permission denied exception is thrown
     *         whenever there was an attempt to supply a uri outside of the base uri
     * @return {String}
     */
    this.calculateUri = function(uri) {
        if (uri.charAt(0) != "/") {
            if (uri.indexOf("://") > -1)
                uri = Url.parse(uri).pathname;
            else
                uri = "/" + uri;
        }
        else if (uri.indexOf("?") > -1)
            uri = Url.parse(uri).pathname;

        uri = uri.replace("//", "/");

        if (uri.indexOf(this.server.baseUri) === 0) {
            return Util.trim(decodeURIComponent(uri.substr(this.server.baseUri.length)), "/");
        }
        // A special case, if the baseUri was accessed without a trailing
        // slash, we'll accept it as well.
        else if (uri + "/" === this.server.baseUri) {
            return "";
        }
        else {
            throw new Exc.Forbidden("Requested uri (" + uri
                + ") is out of base uri (" + this.server.baseUri + ")");
        }
    };

    /**
     * This method checks the main HTTP preconditions.
     *
     * Currently these are:
     *   * If-Match
     *   * If-None-Match
     *   * If-Modified-Since
     *   * If-Unmodified-Since
     *
     * The method will return true if all preconditions are met
     * The method will return false, or throw an exception if preconditions
     * failed. If false is returned the operation should be aborted, and
     * the appropriate HTTP response headers are already set.
     *
     * Normally this method will throw 412 Precondition Failed for failures
     * related to If-None-Match, If-Match and If-Unmodified Since. It will
     * set the status to 304 Not Modified for If-Modified_since.
     *
     * If the handleAsGET argument is set to true, it will also return 304
     * Not Modified for failure of the If-None-Match precondition. This is the
     * desired behaviour for HTTP GET and HTTP HEAD requests.
     *
     * @param  {Boolean}  handleAsGET
     * @param  {Function} cbprecond   Callback that is the return body of this function
     * @return {void}
     */

    // returns true is a redirect was sent
    this.checkPreconditions = async function(node,handleAsGET) {
        handleAsGET = handleAsGET || false;
        var uri, ifMatch, ifNoneMatch, ifModifiedSince, ifUnmodifiedSince;
        var lastMod = null;
        var etag    = null;
        var self    = this;

        if (ifMatch = this.httpRequest.headers["if-match"]) {
            // If-Match contains an entity tag. Only if the entity-tag
            // matches we are allowed to make the request succeed.
            // If the entity-tag is '*' we are only allowed to make the
            // request succeed if a resource exists at that url.
            if (!node)
                throw(new Exc.PreconditionFailed(
                    "An If-Match header was specified and the resource did not exist",
                    "If-Match"));

            // Only need to check entity tags if they are not *
            if (ifMatch !== "*") {
                var eTag = node.getETag()
                var haveMatch = false;
                // There can be multiple etags
                ifMatch = ifMatch.split(",");
                var ifMatchItem;
                for (var i = 0, l = ifMatch.length; i < l; ++i) {
                    // Stripping any extra spaces
                    ifMatchItem = Util.trim(ifMatch[i], " ");
                    if (etag === ifMatchItem) {
                        haveMatch = true;
                        break;
                    } else {
                        // Evolution has a bug where it sometimes prepends the "
                        // with a \. This is our workaround.
                        if (ifMatchItem.replace('\\"','"') === etag) {
                            haveMatch = true;
                            break;
                        }
                    }
                }
                if (!haveMatch) {
                    throw(new Exc.PreconditionFailed(
                        "An If-Match header was specified, but none of the specified the ETags matched",
                        "If-Match")
                         );
                }
            }
        }

        if (ifNoneMatch = self.httpRequest.headers["if-none-match"]) {
            // The If-None-Match header contains an etag.
            // Only if the ETag does not match the current ETag, the request will succeed
            // The header can also contain *, in which case the request
            // will only succeed if the entity does not exist at all.
            if (node) {
                // The Etag is surrounded by double-quotes, so those must be
                // stripped.
                ifNoneMatch = Util.trim(ifNoneMatch, '"');
                var etag = node.getETag()
                if (ifNoneMatch === "*" || etag === ifNoneMatch) {
                    if (handleAsGET) {
                        self.httpResponse.writeHead(304);
                        self.httpResponse.end();
                        return true
                    } else {
                        throw(Exc.PreconditionFailed(
                            "An If-None-Match header was specified, but the ETag "
                                + "matched (or * was specified).", "If-None-Match")
                             );
                    }
                }
            }
        }

        if (!ifNoneMatch && (ifModifiedSince = self.httpRequest.headers["if-modified-since"])) {
            // The If-Modified-Since header contains a date. We
            // will only return the entity if it has been changed since
            // that date. If it hasn't been changed, we return a 304
            // header
            // Note that this header only has to be checked if there was no
            // If-None-Match header as per the HTTP spec.
            var date = new Date(ifModifiedSince);
            lastMod = node.getLastModified()
            if (lastMod) {
                lastMod = new Date("@" + lastMod);
                if (lastMod <= date) {
                    self.httpResponse.writeHead(304);
                    self.httpResponse.end();
                    return true
                }
            }
        }


        if (ifUnmodifiedSince = self.httpRequest.headers["if-unmodified-since"]) {
            // The If-Unmodified-Since will allow the request if the
            // entity has not changed since the specified date.
            var date = new Date(ifUnmodifiedSince);
            lastMod=node.getLastModified()
            if (lastMod) {
                lastMod = new Date("@" + lastMod);
                if (lastMod > date) {
                    throw(new Exc.PreconditionFailed(
                                        "An If-Unmodified-Since header was specified, but the "
                                            + "entity has been changed since the specified date.",
                                        "If-Unmodified-Since")
                                                    );
                }
            }
        }

        return false
    };


    /**
     * Generates a WebDAV propfind response body based on a list of nodes
     *
     * @param  {Array} fileProperties The list with nodes
     * @return {String}
     */
    this.generateMultiStatus = function(fileProperties, strip404s) {
        var namespace, prefix, entry, href, response;
        var xml = '<?xml version="1.0" encoding="utf-8"?><d:multistatus';

        // Adding in default namespaces
        for (namespace in Xml.xmlNamespaces) {
            prefix = Xml.xmlNamespaces[namespace];
            xml += ' xmlns:' + prefix + '="' + namespace + '"';
        }

        xml += ">";

        for (var i in fileProperties) {
            entry = fileProperties[i];
            href = entry["href"];
            //delete entry["href"];

            if (strip404s && entry["404"])
                delete entry["404"];

            response = jsDAV_Property_Response.new(href, entry);
            xml = response.serialize(this, xml);
        }

        return xml + "</d:multistatus>";
    };

    /**
     * Returns a list of HTTP headers for a particular resource
     *
     * The generated http headers are based on properties provided by the
     * resource. The method basically provides a simple mapping between
     * DAV property and HTTP header.
     *
     * The headers are intended to be used for HEAD and GET requests.
     *
     * @param {String} path
     */
    this.asyncGetHTTPHeaders = async function(path) {
        var header;
        var propertyMap = {
            "{DAV:}getcontenttype"   : "content-type",
            "{DAV:}getcontentlength" : "content-length",
            "{DAV:}getlastmodified"  : "last-modified",
            "{DAV:}getetag"          : "etag"
        };
        var headers    = {
            "pragma"        : "no-cache",
            "cache-control" : "no-cache, no-transform"
        };
        var properties = await this.asyncGetProperties(path,
                                                  ["{DAV:}getcontenttype",
                                                   "{DAV:}getcontentlength",
                                                   "{DAV:}getlastmodified",
                                                   "{DAV:}getetag"])
        for (var prop in propertyMap) {
            header = propertyMap[prop];
            if (properties[prop]) {
                        // GetLastModified gets special cased
                if (properties[prop].hasFeature && properties[prop].hasFeature(jsDAV_Property_GetLastModified))
                    headers[header] = Util.dateFormat(properties[prop].getTime(), Util.DATE_RFC1123);
                else if (typeof properties[prop] != "object")
                    headers[header] = properties[prop];
            }
        }
        return headers

    };

    /**
     * Returns a list of properties for a path
     *
     * This is a simplified version getPropertiesForPath.
     * if you aren't interested in status codes, but you just
     * want to have a flat list of properties. Use this method.
     *
     * @param {String} path
     * @param {Array}  propertyNames
     */
    this.asyncGetProperties = async function(path, propertyNames) {
        var result = await this.asyncGetPropertiesForPath(path, propertyNames, 0);
        return result[path]["200"];
    };

    /**
     * Returns a list of properties for a given path
     *
     * The path that should be supplied should have the baseUrl stripped out
     * The list of properties should be supplied in Clark notation. If the list
     * is empty 'allprops' is assumed.
     *
     * If a depth of 1 is requested child elements will also be returned.
     *
     * @param {String} path
     * @param {Array}  propertyNames
     * @param {Number} depth
     * @return {Array}
     */
    this.asyncGetPropertiesForPath = async function(path, propertyNames, depth) {
        propertyNames = propertyNames || [];
        depth = depth || 0;


        if (depth !== 0)
            depth = 1;
        path = Util.rtrim(path, "/");

        var returnPropertyList = {};
        var self = this;
        var reportPlugins = [];
        Object.keys(this.plugins).forEach(function(pluginName) {
            if (self.plugins[pluginName].getSupportedReportSet)
                reportPlugins.push(self.plugins[pluginName]);
        });
        var parentNode = await this.asyncGetNodeForPath(path)

        var nodes = {};
        var nodesPath = [path];
        nodes[path] = parentNode;

        if (depth === 1 && parentNode.hasFeature(jsDAV_iCollection)) {
            var cNodes = await this.tree.lsDir(parentNode)
            for (var i = 0, l = cNodes.length; i < l; ++i) {
                var cPath = path + "/" + cNodes[i].getName()
//                console.log("properties:",path, cPath)
                nodes[cPath] = cNodes[i];
                nodesPath.push(cPath);
            }
        }
        // If the propertyNames array is empty, it means all properties are requested.
        // We shouldn't actually return everything we know though, and only return a
        // sensible list.
        var allProperties = (propertyNames.length === 0);
        if (allProperties) {
            // Default list of propertyNames, when all properties were requested.
            propertyNames = [
                "{DAV:}getlastmodified",
                "{DAV:}getcontentlength",
                "{DAV:}resourcetype",
        //        "{DAV:}quota-used-bytes",
        //        "{DAV:}quota-available-bytes",
                "{DAV:}getetag",
                "{DAV:}getcontenttype"
            ];
        }

        // If the resourceType was not part of the list, we manually add it
        // and mark it for removal. We need to know the resourcetype in order
        // to make certain decisions about the entry.
        // WebDAV dictates we should add a / and the end of href's for collections
        var removeRT = false;
        if (propertyNames.indexOf("{DAV:}resourcetype") === -1) {
            propertyNames.push("{DAV:}resourcetype");
            removeRT = true;
        }

        function afterGetProperty(rprop, rpath, newProps) {
//            console.log(rprop, rpath, newProps)
            // If we were unable to find the property, we will list it as 404.
            if (!allProperties && !newProps["200"][rprop])
                newProps["404"][rprop] = null;
            var node = nodes[rpath];
            rpath = Util.trim(rpath, "/");
            //self.dispatchEvent("afterGetProperties", rpath, newProps, node, function() {
//            if (parentNode.hasFeature(jsDAV_iCollection)) {
                // correct href when mountpoint is different than the
                // absolute location of the path
//                var s = Util.trim(self.server.tree.basePath, "/");
//                if (s.charAt(0) != ".") {
//                    rpath = s.indexOf(self.server.baseUri) !== 0
//                        ? rpath.replace(new RegExp("^" + Util.escapeRegExp(s)), "").replace(/^[\/]+/, "")
//                        : rpath;
//                }
//            }

            newProps["href"] = rpath;

            // Its is a WebDAV recommendation to add a trailing slash to collectionnames.
            // Apple's iCal also requires a trailing slash for principals (rfc 3744).
            // Therefore we add a trailing / for any non-file. This might need adjustments
            // if we find there are other edge cases.
            var rt = newProps["200"]["{DAV:}resourcetype"];
            if (rpath !== "" && rt && (rt.is("{DAV:}collection") || rt.is("{DAV:}principal"))) {
                newProps["href"] += "/";
            }

            // If the resourcetype property was manually added to the requested property list,
            // we will remove it again.
            if (removeRT)
                delete newProps["200"]["{DAV:}resourcetype"];

            returnPropertyList[rpath] = newProps;
        }

        //   Async.list(nodesPath)
        //       .delay(0, 10)
            //       .each(function(myPath, cbnextpfp) {

        await Promise.all(nodesPath.map( async (myPath) => {
            var node = nodes[myPath];
            var newProperties = {
                "200" : {},
                "403" : {},
                "404" : {}
            };
            var myProperties = [].concat(propertyNames);

            var propertyMap = Util.arrayToMap(myProperties);
            //self.dispatchEvent("beforeGetProperties", myPath, node, propertyMap, newProperties, function(stop) {
            //            if (stop)
            //                return cbnextpfp(stop === true ? null : stop);

            myProperties = Object.keys(propertyMap);
            if (node.hasFeature(jsDAV_iProperties)) {
                var props= await this.tree.getProperties(node,myProperties)
                // The getProperties method may give us too much,
                // properties, in case the implementor was lazy.
                //
                // So as we loop through this list, we will only take the
                // properties that were actually requested and discard the
                // rest.
                for (var i = myProperties.length - 1; i >= 0; --i) {
                    if (props[myProperties[i]]) {
                        newProperties["200"][myProperties[i]] = props[myProperties[i]];
                        myProperties.splice(i, 1);
                    }
                }
            }
            myProperties.forEach(function(prop) {
                if (typeof newProperties["200"][prop] != "undefined")
                    return

                if (prop == "{DAV:}getlastmodified") {
                    var dt = node.getLastModified()
                    if (dt)
                        newProperties["200"][prop] = jsDAV_Property_GetLastModified.new(dt);
                    afterGetProperty(prop, myPath, newProperties);
                }
                else if (prop == "{DAV:}getcontentlength" && node.hasFeature(jsDAV_iFile)) {
                    var size = node.getSize()
                    if (typeof size != "undefined")
                        newProperties["200"][prop] = parseInt(size, 10);
                    afterGetProperty(prop, myPath, newProperties);
                }
                //else if (prop == "{DAV:}quota-used-bytes" && node.hasFeature(jsDAV_iQuota)) {
                //    var quotaInfoUsed=await node.getQuotaInfo() // TBD: each/each have to be async
                //    if (quotaInfoUsed.length)
                //        newProperties["200"][prop] = quotaInfoUsed[0];
                //    afterGetProperty(prop, myPath, newProperties);
                //}
                // else if (prop == "{DAV:}quota-available-bytes" && node.hasFeature(jsDAV_iQuota)) {
                //     var quotaInfoAvail = await node.getQuotaInfo()
                //     if (quotaInfoAvail.length)
                //         newProperties["200"][prop] = quotaInfoAvail[1];
                //     afterGetProperty(prop, myPath, newProperties);
                // }
                else if (prop == "{DAV:}getetag" && node.hasFeature(jsDAV_iFile)) {
                    var etag = node.getETag()
                    if (etag)
                        newProperties["200"][prop] = etag;
                    afterGetProperty(prop, myPath, newProperties);
                }
                else if (prop == "{DAV:}getcontenttype" && node.hasFeature(jsDAV_iFile)) {
                    var ct = node.getContentType()
                    if (ct)
                        newProperties["200"][prop] = ct;
                    afterGetProperty(prop, myPath, newProperties);
                }
                // else if (prop == "{DAV:}supported-report-set") {
                //                         var reports = [];
                //                         Async.list(reportPlugins)
                //                             .each(function(plugin, cbnextplugin) {
                //                                 plugin.getSupportedReportSet(myPath, function(err, rset) {
                //                                     if (!err && rset.length)
                //                                         reports = reports.concat(rset);
                //                                     cbnextplugin();
                //                                 });
                //                             })
                //                             .end(function() {
                //                                 newProperties["200"][prop] = jsDAV_Property_SupportedReportSet.new(reports);
                //                                 afterGetProperty(prop, myPath, newProperties, cbnextprops);
                //                             });
                //                     }
                else if (prop == "{DAV:}resourcetype") {
                    newProperties["200"][prop] = jsDAV_Property_ResourceType.new();
                    for (var resourceType in self.resourceTypeMapping) {
                        if (node.hasFeature(self.resourceTypeMapping[resourceType]))
                            newProperties["200"][prop].add(resourceType);
                    }
                    afterGetProperty(prop, myPath, newProperties);
                }
                else {
                    afterGetProperty(prop, myPath, newProperties);
                }
            })
        })); // nodePath.foreach
        return returnPropertyList
    };
    /**
     * Returns the HTTP range header
     *
     * This method returns null if there is no well-formed HTTP range request
     * header or array(start, end).
     *
     * The first number is the offset of the first byte in the range.
     * The second number is the offset of the last byte in the range.
     *
     * If the second offset is null, it should be treated as the offset of the
     * last byte of the entity.
     * If the first offset is null, the second offset should be used to retrieve
     * the last x bytes of the entity.
     *
     * return mixed
     */
    this.getHTTPRange = function() {
        var range = this.httpRequest.headers["range"];
        if (!range)
            return null;

        // Matching "Range: bytes=1234-5678: both numbers are optional
        var matches = range.match(/^bytes=([0-9]*)-([0-9]*)$/i);
        if (!matches || !matches.length)
            return null;

        if (matches[1] === "" && matches[2] === "")
            return null;

        return matches.slice(1).map(function(rangePart) {
            rangePart = parseFloat(rangePart);
            return isNaN(rangePart) ? null : rangePart;
        });
    };

    /**
     * Returns the HTTP depth header
     *
     * This method returns the contents of the HTTP depth request header. If the
     * depth header was 'infinity' it will return the jsDAV_Handler.DEPTH_INFINITY object
     * It is possible to supply a default depth value, which is used when the depth
     * header has invalid content, or is completely non-existant
     *
     * @param  {mixed}   default
     * @return {Number}
     */
    this.getHTTPDepth = function(def) {
        def = def || jsDAV_Handler.DEPTH_INFINITY;
        // If its not set, we'll grab the default
        var depth = this.httpRequest.headers["depth"];
        if (!depth)
            return def;

        if (depth == "infinity")
            return jsDAV_Handler.DEPTH_INFINITY;

        depth = parseInt(depth, 10);
        // If its an unknown value. we'll grab the default
        if (isNaN(depth))
            return def;

        return depth;
    };

    /**
     * Returns the HTTP Prefer header information.
     *
     * The prefer header is defined in:
     * http://tools.ietf.org/html/draft-snell-http-prefer-14
     *
     * This method will return an array with options.
     *
     * Currently, the following options may be returned:
     *   {
     *      "return-asynch"         : true,
     *      "return-minimal"        : true,
     *      "return-representation" : true,
     *      "wait"                  : 30,
     *      "strict"                : true,
     *      "lenient"               : true,
     *   }
     *
     * This method also supports the Brief header, and will also return
     * 'return-minimal' if the brief header was set to 't'.
     *
     * For the boolean options, false will be returned if the headers are not
     * specified. For the integer options it will be 'null'.
     *
     * @return array
     */
    this.getHTTPPrefer = function() {
        var result = {
            "return-asynch"         : false,
            "return-minimal"        : false,
            "return-representation" : false,
            "wait"                  : null,
            "strict"                : false,
            "lenient"               : false
        };

        var prefer = this.httpRequest.headers.prefer;
        if (prefer) {
            prefer.split(",").map(function(item) {
                return Util.trim(item);
            }).forEach(function(parameter) {
                // Right now our regex only supports the tokens actually
                // specified in the draft. We may need to expand this if new
                // tokens get registered.
                var matches = parameter.match(/^([a-z0-9\-]+)(?:=([0-9a-z]+))?$/);

                if (matches !== null && matches.length > 0) {
                    var token = matches[1];

                    // Early RFC drafts declares return-minimal, return-asynch, etc...
                    // Now http://tools.ietf.org/html/rfc7240 declares return=minimal, etc...
                    if (token == "return" && matches[2]) {
                        // Convert return=??? to return-??? for backward compatibility
                        token = token + "-" + matches[2];
                    }

                    switch(token) {
                        case "return-asynch" :
                        case "return-minimal" :
                        case "return-representation" :
                        case "strict" :
                        case "lenient" :
                            result[token] = true;
                            break;
                        case "wait" :
                            result[token] = matches[2];
                            break;
                    }
                }
            });
        }

        var brief = this.httpRequest.headers.brief;
        if (brief && brief == "t")
            result["return-minimal"] = true;

        return result;
    };

    /**
     * This method parses the PROPFIND request and returns its information
     *
     * This will either be a list of properties, or an empty array; in which case
     * an {DAV:}allprop was requested.
     *
     * @param  {String} body
     * @return {Array}
     */
    this.parsePropfindRequest = function(body) {
        // If the propfind body was empty, it means IE is requesting 'all' properties
        if (!body)
            return []
        var oXml = Xml.loadDOMDocument(body, this.server.options.parser)
        //Util.log("XML ", oXml);
        return Object.keys(Xml.parseProperties(oXml.propfind || oXml));

    };

    /**
     * This method parses a Proppatch request
     *
     * Proppatch changes the properties for a resource. This method
     * returns a list of properties.
     *
     * The keys in the returned array contain the property name (e.g.: {DAV:}displayname,
     * and the value contains the property value. If a property is to be removed
     * the value will be null.
     *
     * @param  {String}   body           Xml body
     * @param  {Function} cbproppatchreq Callback that is the return body of this function
     * @return {Object}   list of properties in need of updating or deletion
     */
    this.parseProppatchRequest = async function(body) {
//        console.log("parsing proppatch", body)
        //We'll need to change the DAV namespace declaration to something else
        //in order to make it parsable
        var operation, innerProperties, propertyValue;
        var dom = Xml.loadDOMDocument(body, this.server.options.parser)
        var child, propertyName;
        var newProperties = {};
        var i             = 0;
        var c             = dom.childNodes;
        var l             = c.length;
        for (; i < l; ++i) {
            child     = c[i];
            operation = Xml.toClarkNotation(child);
            if (!operation || operation !== "{DAV:}set" && operation !== "{DAV:}remove")
                continue;
            innerProperties = Xml.parseProperties(child, this.propertyMap);
            for (propertyName in innerProperties) {
                propertyValue = innerProperties[propertyName];
                if (operation === "{DAV:}remove")
                    propertyValue = null;
                newProperties[propertyName] = propertyValue;
            }
        }
        return newProperties;
    };

    /**
     * This method updates a resource's properties
     *
     * The properties array must be a list of properties. Array-keys are
     * property names in clarknotation, array-values are it's values.
     * If a property must be deleted, the value should be null.
     *
     * Note that this request should either completely succeed, or
     * completely fail.
     *
     * The response is an array with statuscodes for keys, which in turn
     * contain arrays with propertynames. This response can be used
     * to generate a multistatus body.
     *
     * @param  {String}  uri
     * @param  {Object}  properties
     * @return {Object}
     */
    this.updateProperties = async function(uri, properties) {
        // we'll start by grabbing the node, this will throw the appropriate
        // exceptions if it doesn't.
        var props;
        var remainingProperties = Util.extend({}, properties);
        var hasError = false;
        var result = {};
        result[uri] = {
            "200" : [],
            "403" : [],
            "424" : []
        };

        var node = await this.asyncGetNodeForPath(uri)
        // If the node is not an instance of jsDAV_iProperties, every
        // property is 403 Forbidden
        // simply return a 405.
        var propertyName;
        if (!node.hasFeature(jsDAV_iProperties)) {
            hasError = true;
            for (propertyName in properties)
                Util.arrayRemove(result[uri]["403"], propertyName);
            remainingProperties = {};
        }

        // Running through all properties to make sure none of them are protected
        if (!hasError) {
            for (propertyName in properties) {
                if (this.protectedProperties.indexOf(propertyName) > -1) {
                    Util.arrayRemove(result[uri]["403"], propertyName);
                    delete remainingProperties[propertyName];
                    hasError = true;
                }
            }
        }

            // Only if there were no errors we may attempt to update the resource
        if (!hasError) {
            var updateResult = await this.tree.updateProperties(node,properties)
            remainingProperties = {};
            if (updateResult === true) {
                // success
                for (propertyName in properties)
                    Util.arrayRemove(result[uri]["200"], propertyName);
            }
            else if (updateResult === false) {
                // The node failed to update the properties for an
                // unknown reason
                for (propertyName in properties)
                    Util.arrayRemove(result[uri]["403"], propertyName);
            }
            else if (typeof updateResult == "object") {
                // The node has detailed update information
                result[uri] = updateResult;
            } else {
                throw (new Exc.jsDAV_Exception("Invalid result from updateProperties"));
            }
        }

        for (propertyName in remainingProperties) {
            // if there are remaining properties, it must mean
            // there's a dependency failure
            Util.arrayRemove(result[uri]["424"], propertyName);
        }

        // Removing empty array values
        for (var status in result[uri]) {
            if (!result[uri][status].length)
                delete result[uri][status];
        }
        result[uri]["href"] = uri;
        return result;
    };

    /**
     * Use this method to create a new collection
     *
     * The {DAV:}resourcetype is specified using the resourceType array.
     * At the very least it must contain {DAV:}collection.
     *
     * The properties array can contain a list of additional properties.
     *
     * @param  {string} uri          The new uri
     * @param  {Array}  resourceType The resourceType(s)
     * @param  {Object} properties   A list of properties
     * @return {void}
     */
    this.createCollection = async function(uri, resourceType, properties) {
        var path      = Util.splitPath(uri);
        var parentUri = path[0];
        var newName   = path[1];

        // Making sure {DAV:}collection was specified as resourceType
        if (resourceType.indexOf("{DAV:}collection") == -1) {
            throw(new Exc.InvalidResourceType(
                "The resourceType for this collection must at least include {DAV:}collection")
            );
        }

        // Making sure the parent exists
        var parent =  await this.asyncGetNodeForPath(parentUri,true)
        if (!parent)
            throw(new Exc.Conflict("Parent node doesn't exist"));
        // Making sure the parent is a collection
        if (!parent.hasFeature(jsDAV_iCollection))
            throw(new Exc.Conflict("Parent node is not a collection"));

        // Making sure the child does not already exist
        var ch = await this.asyncGetNodeForPath(uri, true)
        // If we got here.. it means there's already a node on that url,
        // and we need to throw a 405
        if (ch) {
            throw(new Exc.MethodNotAllowed(
                "The resource you tried to create already exists")
                 );
        }


        // There are 2 modes of operation. The standard collection
        // creates the directory, and then updates properties
        // the extended collection can create it directly.
        if (parent.hasFeature(jsDAV_iExtendedCollection)) {
            await this.tree.mkDir(parent,newName, resourceType, properties);
        } else {
            throw(new Exc.NotImplemented()) // this is not migrated yet
            // No special resourcetypes are supported TBD: test!!!
            if (resourceType.length > 1) {
                throw(new Exc.InvalidResourceType(
                    "The {DAV:}resourcetype you specified is not supported here.")
                     );
            }
            var res = await parent.createDirectory(newName)
            if (properties.length > 0) {
                try {
                    var errorResult = await self.updateProperties(uri, properties)
                    if (!errorResult["200"].length) {
                        rollback(new Exc.InvalidResourceType("Need another exception here!"));
                    } else {
                        return
                    }

                } catch (err) {
                    rollback(err, errorResult);
                }

                function rollback(exc) {
                    var node = self.tree.getNodeForPath(uri)
                    node["delete"]();
                    throw(err)
                }
            }
        }
    };

    /**
     * Returns information about Copy and Move requests
     *
     * This function is created to help getting information about the source and
     * the destination for the WebDAV MOVE and COPY HTTP request. It also
     * validates a lot of information and throws proper exceptions
     *
     * The returned value is an array with the following keys:
     *   * source - Source path
     *   * destination - Destination path
     *   * destinationExists - Wether or not the destination is an existing url
     *     (and should therefore be overwritten)
     *
     * @return {Object}
     */
    this.getCopyAndMoveInfo = async function() {
        var source = this.getRequestUri();
        var sourceNode = await this.asyncGetNodeForPath(source);
        // Collecting the relevant HTTP headers
        if (!this.httpRequest.headers["destination"])
            throw(new Exc.BadRequest("The destination header was not supplied"));

        var destination = this.calculateUri(this.httpRequest.headers["destination"]);

        var overwrite = this.httpRequest.headers["overwrite"] || "T";
        if (overwrite.toUpperCase() == "T") {
            overwrite = true;
        } else if (overwrite.toUpperCase() == "F") {
            overwrite = false;
        } else {
            // We need to throw a bad request exception, if the header was invalid
            throw(new Exc.BadRequest(
                "The HTTP Overwrite header should be either T or F")
            );
        }

        var destinationDir = Util.splitPath(destination)[0];
        var destinationName = Util.splitPath(destination)[1];
        // Collection information on relevant existing nodes
        try {
            var destinationParent = await this.asyncGetNodeForPath(destinationDir)
        } catch (ex) {
            if (ex.type == "FileNotFound") {
                throw(new Exc.Conflict("The destination is not found"))
            } else {
                throw(ex);
            }
        }

        if (!destinationParent.hasFeature(jsDAV_iCollection)) {
            throw(new Exc.UnsupportedMediaType("The destination node is not a collection"));
        }


        var destinationNode = await this.asyncGetNodeForPath(destination, true)
        // Destination didn't exist, we're all good
        if (destinationNode && !overwrite) {
            throw(new Exc.PreconditionFailed(
                "The destination node already exists, and the overwrite header is set to false",
                "Overwrite"));
        }

        return {
            "source"            : source,
            "sourceNode"        : sourceNode,
            "overwrite"         : overwrite,
            "destination"       : destination,
            "destinationExists" : destinationNode!=null,
            "destinationNode"   : destinationNode,
            "destinationName"   : destinationName,
            "destinationParentNode": destinationParent
        }
    };

    // is called back
    this.getStatusMessage = function(code) {
        code = String(code);
        return "HTTP/1.1 " + code + " " + jsDAV_Handler.STATUS_MAP[code];
    };
}).call(jsDAV_Handler.prototype = new AsyncEventEmitter());
