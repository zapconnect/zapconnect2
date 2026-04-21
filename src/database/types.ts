export interface User {
  id: number;

  name: string;
  email: string;

  password: string;

  prompt: string;
  ia_enabled: number; // 0 ou 1 (boolean no banco)

  token: string;
  token_expires_at?: number | null;

  created_at?: number;
}
