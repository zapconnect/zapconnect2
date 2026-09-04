export interface User {
  id: number;

  name: string;
  email: string;
  email_normalized?: string | null;
  email_verified?: number;
  google_id?: string | null;

  password: string;

  prompt: string;
  ai_config?: string | null;
  ia_enabled: number; // 0 ou 1 (boolean no banco)
  onboarding_step?: number | null;

  token: string;
  token_expires_at?: number | null;
  timezone_offset?: number | null;
  default_ddi?: string | null;
  default_session_name?: string | null;
  billing_default_type?: string | null;
  billing_default_description?: string | null;
  billing_default_pix_key?: string | null;
  billing_default_link_pagamento?: string | null;
  billing_default_multa?: number | null;
  billing_default_juros?: number | null;
  billing_default_desconto?: number | null;
  billing_default_desconto_dias?: number | null;
  template_cobranca_criacao?: string | null;
  template_cobranca_lembrete?: string | null;
  template_cobranca_atraso?: string | null;
  template_cobranca_confirmacao?: string | null;
  template_cobranca_cancelamento?: string | null;

  created_at?: number;
}
