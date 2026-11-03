import { ServerResponse, type IncomingMessage, type Server } from "node:http";
import { Server as NetServer, type AddressInfo, type Socket } from "node:net";
import { serve, type Http2Bindings, type HttpBindings } from "@hono/node-server";

/** What the server answers requests with, such as the Hono app's `fetch`. */
export type FetchHandler = (
  request: Request,
  env: HttpBindings | Http2Bindings,
) => Response | Promise<Response>;

/**
 * Why the server reset a connection: its client did not take its responses in time
 * (`write_timeout`), or it pipelined more requests than one connection may have waiting (`backlog`).
 */
export type ResetReason = "write_timeout" | "backlog";

export const RESET_REASONS: readonly ResetReason[] = ["write_timeout", "backlog"];

export interface ServerOptions {
  readonly port: number;
  readonly host: string;
  /**
   * How long the responses of a connection may wait for their client once they are ready
   * (RESPONSE_WRITE_TIMEOUT_MS).
   */
  readonly responseWriteTimeoutMs: number;
  /**
   * Requests one connection may have whose responses have not been handed to the network yet
   * (MAX_PIPELINED_REQUESTS); one more resets the connection.
   */
  readonly maxPipelinedRequests: number;
  /** Called when a connection is reset, with the number of responses dropped with it. Must not throw. */
  readonly onReset?: (reason: ResetReason, dropped: number) => void;
}

export interface ServiceServer {
  readonly server: Server;
  /**
   * Stops accepting connections and calls `done` once every open one has ended. Requests being
   * answered finish as usual, and their answers close their connection. A connection with no request
   * being answered (idle, or with a request whose headers or body are still arriving) is closed at
   * once, and a ready response waits at most SHUTDOWN_WRITE_MS more for its client, so no client holds
   * the shutdown up; only handlers still at work do.
   */
  close(done: () => void): void;
}

/** Once shutdown has begun, the longest a ready response waits for its client. */
export const SHUTDOWN_WRITE_MS = 1_000;

/** A response on a connection, in the order the connection's requests came in. */
interface Pending {
  readonly outgoing: ServerResponse;
  /** Whether the request was handed to the app; otherwise the server answered it itself. */
  dispatched: boolean;
  /** Whether its answer has been given. */
  ready: boolean;
  /** When it and every response before it on the connection were ready: its clock starts then. */
  readyAt: number | undefined;
}

/** A connection's responses not yet handed to the network, in the order they are written. */
interface Connection {
  readonly socket: Socket;
  readonly pending: Pending[];
  timer: NodeJS.Timeout | undefined;
}

/**
 * Starts the HTTP server that answers with `fetch` on the configured address.
 *
 * Node's own timeouts bound only receiving a request. Once handlers have answered, a client that
 * stops reading, or reads too slowly, would otherwise hold its connection and every response waiting
 * on it; a discovery page alone can be megabytes, and a client can pipeline thousands of requests
 * before Node stops reading them. So every response is followed from its request's arrival, the
 * answers the server gives without the app included (a request the app cannot read, an expectation it
 * cannot meet):
 * - a connection may have at most `maxPipelinedRequests` requests whose responses have not been
 *   handed to the network; a client that sends more is reset, and the requests it already sent are
 *   never answered. A client that waits for each answer before it asks again is never affected;
 * - the responses of a connection must be handed to the network (taken into the operating system's
 *   socket buffer) within `responseWriteTimeoutMs` of being ready, or the connection is reset and
 *   everything it held is released. Responses are written in request order, so one is ready once its
 *   answer and every answer before it on the connection have been given: the time a handler takes,
 *   such as a settlement waiting for a channel and for confirmation, is never counted. Every response
 *   of the service is complete when its handler answers (none is a stream), so this bounds its
 *   delivery as a whole, however slowly the client reads.
 */
export function listen(
  fetch: FetchHandler,
  options: ServerOptions,
  onListening?: (info: AddressInfo) => void,
): ServiceServer {
  const timeoutMs = options.responseWriteTimeoutMs;
  const maxPipelined = Math.max(1, options.maxPipelinedRequests);
  /** Every open connection. */
  const sockets = new Set<Socket>();
  /** The open connections with responses not yet handed to the network. */
  const connections = new Map<Socket, Connection>();
  const pendingOf = new WeakMap<ServerResponse, Pending>();
  /** Connections reset for their backlog: the requests they already sent are not answered. */
  const dropped = new WeakSet<Socket>();
  let shutdownAt: number | undefined;

  /** When a response that was ready at `readyAt` must have been taken. */
  const deadlineOf = (readyAt: number) =>
    shutdownAt === undefined
      ? readyAt + timeoutMs
      : Math.min(readyAt + timeoutMs, Math.max(readyAt, shutdownAt) + SHUTDOWN_WRITE_MS);

  /** Forgets a connection's responses and closes it, at once and without sending what is left. */
  const drop = (connection: Connection) => {
    const count = connection.pending.length;
    clearTimeout(connection.timer);
    connections.delete(connection.socket);
    connection.pending.length = 0;
    dropped.add(connection.socket);
    // A reset also drops what the kernel still holds for the client, where a close would keep it
    // queued until the client reads or the kernel gives up.
    try {
      connection.socket.resetAndDestroy();
    } catch {
      connection.socket.destroy();
    }
    return count;
  };

  const reset = (connection: Connection, reason: ResetReason) => {
    const count = drop(connection);
    options.onReset?.(reason, count);
  };

  /** Starts the clock of every response that has just become ready, and times the oldest one. */
  const refresh = (connection: Connection) => {
    const now = performance.now();
    for (const pending of connection.pending) {
      if (!pending.ready) break;
      pending.readyAt ??= now;
    }
    clearTimeout(connection.timer);
    connection.timer = undefined;
    const head = connection.pending[0];
    if (head === undefined) {
      connections.delete(connection.socket);
      // Shutting down: nothing is left to send on it, so it is closed rather than kept alive.
      if (shutdownAt !== undefined) connection.socket.destroy();
      return;
    }
    // Shutting down: a request whose body is still arriving has started no work (a handler reads the
    // whole body before it acts on it, as /verify and /settle do), so it is dropped, not waited for.
    // Only the last request of a connection can be incomplete, so it is the head once the rest is sent.
    if (shutdownAt !== undefined && !head.ready && !head.outgoing.req.complete) {
      drop(connection);
      return;
    }
    if (head.readyAt === undefined) return;
    connection.timer = setTimeout(
      () => {
        reset(connection, "write_timeout");
      },
      Math.max(0, deadlineOf(head.readyAt) - now),
    );
    connection.timer.unref();
  };

  const ready = (socket: Socket, pending: Pending) => {
    if (pending.ready) return;
    pending.ready = true;
    const connection = connections.get(socket);
    if (connection !== undefined) refresh(connection);
  };

  /**
   * Follows a request's response from the request's arrival until the response is sent; undefined when
   * the request is not answered, because its connection was reset.
   */
  const follow = (incoming: IncomingMessage, outgoing: ServerResponse): Pending | undefined => {
    const socket = incoming.socket;
    if (dropped.has(socket)) return undefined;
    let connection = connections.get(socket);
    if (connection === undefined) {
      connection = { socket, pending: [], timer: undefined };
      connections.set(socket, connection);
    }
    if (connection.pending.length >= maxPipelined) {
      reset(connection, "backlog");
      return undefined;
    }
    const pending: Pending = { outgoing, dispatched: false, ready: false, readyAt: undefined };
    connection.pending.push(pending);
    pendingOf.set(outgoing, pending);
    const owner = connection;
    const settled = () => {
      const index = owner.pending.indexOf(pending);
      if (index === -1) return;
      owner.pending.splice(index, 1);
      refresh(owner);
    };
    // Handed to the network, or its connection closed.
    outgoing.once("finish", settled);
    outgoing.once("close", settled);
    // Shutting down: once the parser is done with this request, see whether its body is still arriving.
    if (shutdownAt !== undefined) {
      setImmediate(() => {
        if (connections.get(socket) === owner) refresh(owner);
      });
    }
    return pending;
  };

  const deliver: FetchHandler = async (request, env) => {
    const { incoming, outgoing } = env;
    if (!(outgoing instanceof ServerResponse)) return fetch(request, env);
    const pending = pendingOf.get(outgoing);
    // A request of a connection reset for its backlog: it is not answered.
    if (pending === undefined) return new Response(null, { status: 503 });
    pending.dispatched = true;
    try {
      const response = await fetch(request, env);
      // An answer given during shutdown closes its connection.
      if (shutdownAt !== undefined && !outgoing.headersSent) outgoing.setHeader("connection", "close");
      return response;
    } finally {
      ready(incoming.socket, pending);
    }
  };

  const server = serve({ fetch: deliver, port: options.port, hostname: options.host }, onListening) as Server;
  server.prependListener("request", (incoming: IncomingMessage, outgoing: ServerResponse) => {
    follow(incoming, outgoing);
  });
  // After the app's own listener: a request it answered without reaching the app (one it could not
  // read) has its answer already.
  server.on("request", (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const pending = pendingOf.get(outgoing);
    if (pending !== undefined && !pending.dispatched) ready(incoming.socket, pending);
  });
  // An expectation other than 100-continue: answered 417, as Node does, and followed like any answer.
  server.on("checkExpectation", (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const pending = follow(incoming, outgoing);
    if (pending === undefined) return;
    if (shutdownAt !== undefined) outgoing.setHeader("connection", "close");
    outgoing.writeHead(417);
    outgoing.end();
    ready(incoming.socket, pending);
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return {
    server,
    close(done) {
      shutdownAt = performance.now();
      // Stops accepting connections. The HTTP server's own close would also drop at once every
      // connection whose answer has been written but not yet sent; connections are let go here.
      NetServer.prototype.close.call(server, () => {
        done();
      });
      for (const socket of sockets) if (!connections.has(socket)) socket.destroy();
      for (const connection of [...connections.values()]) refresh(connection);
    },
  };
}
