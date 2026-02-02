export interface User {
  id: number;

  name: string;
  email: string;

  password: string;

  prompt: string;
  ia_enabled: number; // 0 ou 1 (boolean no banco)

  token: string;

  created_at?: number;
}
