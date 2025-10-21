import { OpenAPIV3_1 } from 'openapi-types';

export const swaggerSpec: OpenAPIV3_1.Document = {
  openapi: '3.0.3',
  info: {
    title: 'ERP CRP API',
    version: '1.0.0',
    description:
      'Documentation des endpoints ERP CRP pour la gestion des clients. Authentification par JWT (Bearer).',
  },
  servers: [
    { url: '/api/v1', description: 'API v1 (même host)' },
    // { url: 'https://api.crp-systems.croix-rousse-precision.fr/api/v1', description: 'Prod' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      // ------- INPUT SCHEMAS (alignés avec Zod) -------
      AddressInput: {
        type: 'object',
        required: ['name', 'street', 'postal_code', 'city', 'country'],
        properties: {
          name: { type: 'string', minLength: 1 },
          street: { type: 'string', minLength: 1 },
          house_number: { type: ['string', 'null'] },
          postal_code: { type: 'string', minLength: 1 },
          city: { type: 'string', minLength: 1 },
          country: { type: 'string', minLength: 1 },
        },
      },
      BankInline: {
        type: 'object',
        required: ['bank_name', 'iban', 'bic'],
        properties: {
          bank_name: { type: 'string', minLength: 1 },
          iban: { type: 'string', minLength: 15 },
          bic: { type: 'string', minLength: 8 },
        },
        example: { bank_name: 'BNP Paribas', iban: 'FR7612345678901234567890123', bic: 'ABCDEFGHXXX' },
      },
      PrimaryContactInput: {
        type: 'object',
        required: ['first_name', 'last_name', 'email'],
        properties: {
          first_name: { type: 'string', minLength: 1 },
          last_name: { type: 'string', minLength: 1 },
          email: { type: 'string', format: 'email' },
          phone_personal: { type: ['string', 'null'] },
          role: { type: ['string', 'null'] },
          civility: { type: ['string', 'null'] },
        },
      },
      // src/swagger/swagger.ts (components.schemas.CreateClientDTO)
CreateClientDTO: {
  type: 'object',
  required: [
    'company_name',
    'status',
    'blocked',
    'creation_date',
    'payment_mode_ids',
    'bank',
    'bill_address',
    'delivery_address',
  ],
  properties: {
    company_name: { type: 'string', minLength: 1 },
    email: { type: ['string','null'], format: 'email' },
    phone: { type: ['string','null'] },
    website_url: { type: ['string','null'], format: 'uri' },
    siret: { type: ['string','null'] },
    vat_number: { type: ['string','null'] },
    naf_code: { type: ['string','null'] },
    status: { type: 'string', enum: ['prospect', 'client', 'inactif'] },
    blocked: { type: 'boolean' },
    reason: { type: ['string','null'] },
    creation_date: { type: 'string' },

    payment_mode_ids: { type: 'array', items: { type: 'string' }, default: [] },

    bank: { $ref: '#/components/schemas/BankInline' },

    observations: { type: ['string','null'] },
    provided_documents_id: { type: ['string','null'] },

    bill_address: { $ref: '#/components/schemas/AddressInput' },
    delivery_address: { $ref: '#/components/schemas/AddressInput' },

    primary_contact: { $ref: '#/components/schemas/PrimaryContactInput' },
  },
  example: {
    company_name: 'ACME SAS',
    email: 'contact@acme.fr',
    phone: '+33 4 72 00 00 00',
    website_url: 'https://acme.fr',
    siret: '12345678900011',
    vat_number: 'FR12 345678900',
    naf_code: '2562B',
    status: 'client',
    blocked: false,
    reason: '',
    creation_date: '2025-10-20T10:12:00Z',
    payment_mode_ids: ['CHQ','VIR'],
    bank: { bank_name: 'BNP Paribas', iban: 'FR7612345678901234567890123', bic: 'ABCDEFGHXXX' },
    observations: 'Client historique',
    provided_documents_id: '',
    bill_address: {
      name: 'ACME Facturation', street: '10 rue de la Paix', house_number: 'B',
      postal_code: '69001', city: 'Lyon', country: 'France'
    },
    delivery_address: {
      name: 'ACME Entrepôt', street: '25 avenue des Frères',
      postal_code: '69800', city: 'Saint-Priest', country: 'France'
    },
    primary_contact: {
      first_name: 'Jeanne', last_name: 'Durand', email: 'jeanne.durand@acme.fr',
      phone_personal: '+33 6 12 34 56 78', role: 'Acheteuse', civility: 'Mme'
    }
  }
},


      // ------- OUTPUT SCHEMAS -------
      CreateClientResponse: {
        type: 'object',
        required: ['client_id'],
        properties: { client_id: { type: 'string', description: 'Identifiant interne formaté 001, 002, ...' } },
        example: { client_id: '007' },
      },

      ClientListItem: {
        type: 'object',
        required: ['client_id', 'company_name'],
        properties: {
          client_id: { type: 'string' },
          company_name: { type: 'string' },
          email: { type: ['string', 'null'] },
          siret: { type: ['string', 'null'] },
        },
        example: {
          client_id: '023',
          company_name: 'TechnoParts',
          email: 'info@technoparts.fr',
          siret: '42132132100022',
        },
      },

      ClientLightListResponse: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClientListItem' },
      },

      ClientEntity: {
        type: 'object',
        required: ['client_id', 'company_name', 'status', 'blocked', 'creation_date'],
        properties: {
          client_id: { type: 'string' },
          company_name: { type: 'string' },
          email: { type: ['string', 'null'] },
          phone: { type: ['string', 'null'] },
          website_url: { type: ['string', 'null'] },
          siret: { type: ['string', 'null'] },
          vat_number: { type: ['string', 'null'] },
          naf_code: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['prospect', 'client', 'inactif'] },
          blocked: { type: 'boolean' },
          reason: { type: ['string', 'null'] },
          creation_date: { type: 'string' },
          observations: { type: ['string', 'null'] },
          provided_documents_id: { type: ['string', 'null'] },
        },
      },
      BillerRef: {
        type: 'object',
        required: ['id', 'name'],
        properties: { id: { type: 'string' }, name: { type: 'string' } },
      },
      AddressOut: {
        type: 'object',
        required: ['id', 'name', 'street', 'postal_code', 'city', 'country'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          street: { type: 'string' },
          house_number: { type: ['string', 'null'] },
          postal_code: { type: 'string' },
          city: { type: 'string' },
          country: { type: 'string' },
        },
      },
      BankOut: {
        type: 'object',
        required: ['id', 'bank_name', 'iban', 'bic'],
        properties: {
          id: { type: 'string' },
          bank_name: { type: 'string' },
          iban: { type: 'string' },
          bic: { type: 'string' },
        },
      },
      PrimaryContactOut: {
        type: 'object',
        required: ['contact_id', 'first_name', 'last_name', 'email'],
        properties: {
          contact_id: { type: 'string' },
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          civility: { type: ['string', 'null'] },
          role: { type: ['string', 'null'] },
          phone_personal: { type: ['string', 'null'] },
          email: { type: 'string' },
        },
      },
      PaymentModeOut: {
        type: 'object',
        required: ['id', 'code', 'type'],
        properties: {
          id: { type: 'string' },
          code: { type: 'string' },
          type: { type: 'string' },
        },
      },

      GetClientByIdResponse: {
        type: 'object',
        required: ['client', 'bill_address', 'delivery_address', 'bank', 'payment_modes'],
        properties: {
          client: { $ref: '#/components/schemas/ClientEntity' },
          biller: { oneOf: [{ $ref: '#/components/schemas/BillerRef' }, { type: 'null' }] },
          bill_address: { $ref: '#/components/schemas/AddressOut' },
          delivery_address: { $ref: '#/components/schemas/AddressOut' },
          bank: { $ref: '#/components/schemas/BankOut' },
          primary_contact: { oneOf: [{ $ref: '#/components/schemas/PrimaryContactOut' }, { type: 'null' }] },
          payment_modes: {
            type: 'array',
            items: { $ref: '#/components/schemas/PaymentModeOut' },
          },
        },
      },

      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
        },
        example: { error: 'BadRequest', message: 'Invalid payload' },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  tags: [{ name: 'Clients' }],
  paths: {
    '/clients': {
      post: {
        tags: ['Clients'],
        summary: 'Créer un client',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateClientDTO' } },
          },
        },
        responses: {
          '201': {
            description: 'Créé',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateClientResponse' } } },
          },
          '400': { description: 'Requête invalide', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          '401': { description: 'Non authentifié' },
          '409': { description: 'Conflit (ex: IBAN déjà lié & contrainte)' },
          '500': { description: 'Erreur serveur' },
        },
      },
      get: {
        tags: ['Clients'],
        summary: 'Lister des clients (light)',
        parameters: [
          {
            name: 'q',
            in: 'query',
            required: false,
            description: 'Recherche (company_name, client_id, email, siret). Sans q : tout.',
            schema: { type: 'string' },
            example: 'acme',
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', default: 25, minimum: 1, maximum: 200 },
          },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientLightListResponse' } } },
          },
          '401': { description: 'Non authentifié' },
          '500': { description: 'Erreur serveur' },
        },
      },
    },
    '/clients/{id}': {
      get: {
        tags: ['Clients'],
        summary: 'Obtenir un client (payload complet)',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            example: '007',
          },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/GetClientByIdResponse' } } },
          },
          '401': { description: 'Non authentifié' },
          '404': { description: 'Non trouvé' },
          '500': { description: 'Erreur serveur' },
        },
      },
    },
  },
};
