// src/types/express.d.ts
import { User } from "../database/types";

declare global {
  namespace Express {
    export interface Request {
      user?: User;
    }
  }
}
