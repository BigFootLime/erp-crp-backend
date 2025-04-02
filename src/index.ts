import app from './config/app';
import dotenv from 'dotenv';

// Chargement des variables d'environnement
dotenv.config();

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Serveur ERP lancé sur http://localhost:${PORT}`);
});
