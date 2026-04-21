import type { Server } from "socket.io";

let socketServer: Server | null = null;

export function setSocketServer(io: Server) {
  socketServer = io;
}

export function getSocketServer() {
  return socketServer;
}

export function emitToUser(userId: number | string, event: string, payload?: unknown) {
  if (!socketServer) return false;
  socketServer.to(`user:${userId}`).emit(event, payload);
  return true;
}

export function emitToRoom(room: string, event: string, payload?: unknown) {
  if (!socketServer) return false;
  socketServer.to(room).emit(event, payload);
  return true;
}
