export namespace db {
	
	export class HopRecord {
	    ttl: number;
	    ip: string;
	    hostname: string;
	    rtt: number;
	    success: boolean;
	    isFinal: boolean;
	
	    static createFrom(source: any = {}) {
	        return new HopRecord(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ttl = source["ttl"];
	        this.ip = source["ip"];
	        this.hostname = source["hostname"];
	        this.rtt = source["rtt"];
	        this.success = source["success"];
	        this.isFinal = source["isFinal"];
	    }
	}
	export class TraceRecord {
	    id: number;
	    destination: string;
	    createdAt: string;
	    hopCount: number;
	    timeoutCount: number;
	    totalRtt: number;
	
	    static createFrom(source: any = {}) {
	        return new TraceRecord(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.destination = source["destination"];
	        this.createdAt = source["createdAt"];
	        this.hopCount = source["hopCount"];
	        this.timeoutCount = source["timeoutCount"];
	        this.totalRtt = source["totalRtt"];
	    }
	}

}

