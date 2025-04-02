import swaggerJSDoc from 'swagger-jsdoc';

export const swaggerOptions: swaggerJSDoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'ERP - Croix Rousse Précision',
      version: '1.0.0',
      description: 'Documentation de l’API ERP pour la mécanique de précision',
    },
    servers: [
      {
        url: 'http://localhost:5000/api/v1',
        description: 'Serveur local',
      },
    ],
  },
  apis: ['src/docs/*.ts'], // Tous les fichiers de doc
};

export const swaggerSpec = swaggerJSDoc(swaggerOptions);
