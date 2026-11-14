# WhatsApp Cloud API oficial (Meta)

O painel oferece dois provedores: conexão por QR Code com WPPConnect e conexão oficial pela WhatsApp Cloud API. As sessões guardam o provedor e os dados Meta separados. O token do cliente fica criptografado em AES-256-GCM no MySQL.

## Preparação da aplicação Meta

1. Use um aplicativo Meta do tipo Business e configure WhatsApp e Facebook Login for Business.
2. Crie uma configuração de Embedded Signup v4 com o produto Cloud API. Solicite acesso avançado a **whatsapp_business_management** e **whatsapp_business_messaging**.
3. Conclua a verificação da empresa e a revisão/acesso avançado exigidos pela Meta antes de disponibilizar o onboarding para clientes.
4. Configure o webhook da aplicação para **https://SEU_DOMINIO/webhook/meta**, com o mesmo token definido em **META_WEBHOOK_VERIFY_TOKEN**. Inscreva o objeto WhatsApp Business Account no campo **messages**.
5. Adicione o domínio HTTPS do painel às configurações de Facebook Login for Business e copie o App ID, App Secret e Configuration ID.

## Variáveis do servidor

Copie as chaves do **.env.example** para o ambiente do servidor:

- **META_APP_ID**
- **META_APP_SECRET**
- **META_EMBEDDED_SIGNUP_CONFIG_ID**
- **META_WEBHOOK_VERIFY_TOKEN**
- **META_TOKEN_ENCRYPTION_KEY** — chave exclusiva de 32 bytes em hexadecimal (64 caracteres).
- **META_GRAPH_API_VERSION** — padrão atual no projeto: **v27.0**.

Mantenha **META_TOKEN_ENCRYPTION_KEY** estável entre reinicializações e backups. Trocar a chave sem recriptografar os tokens salvos impede a restauração das sessões Meta.

## Fluxo do cliente

No painel, escolha **API Oficial Meta**, informe um nome e um PIN de 6 dígitos para a verificação em duas etapas do número. A janela Meta autoriza a conta e retorna o WABA ID, o Phone Number ID e o código de autorização. O servidor troca o código por um token, registra o número, assina os webhooks e persiste o token criptografado.

No modelo implementado, cada empresa cliente configura o pagamento na própria conta de WhatsApp Business da Meta. O ZapConnect não recebe nem repassa as tarifas da Meta.

## Mensagens e limites

- Mensagens recebidas e status de entrega chegam pelo webhook oficial, com validação da assinatura HMAC e deduplicação.
- Texto e arquivos recebidos são encaminhados ao mesmo pipeline de atendimento do provedor QR. O histórico Meta é carregado do banco e a mídia é servida por uma rota autenticada.
- Envios de texto e arquivos funcionam durante a janela de atendimento de 24 horas iniciada por uma mensagem do cliente.
- O chat permite buscar e enviar modelos Meta aprovados com corpo de texto e rodapé opcional, com campos para preencher variáveis. Modelos com cabeçalho de mídia ou botões ainda não entram neste seletor.
- Fora da janela de 24 horas, texto livre, arquivos, campanhas e agendamentos são recusados com orientação para usar um modelo. A interface de modelos cobre mensagens manuais do chat; a conversão de campanhas e agendamentos em modelos ainda não está implementada.

## Referências oficiais

- [Embedded Signup e requisitos de onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview)
- [Embedded Signup v4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4)
- [Requisições seguras da Graph API](https://developers.facebook.com/docs/graph-api/guides/secure-requests)
- [Webhooks Meta: assinatura, HTTPS e repetição de eventos](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/)
- [Preços da WhatsApp Business Platform](https://business.whatsapp.com/products/platform-pricing)
