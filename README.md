# L’atelier

Application Next.js (App Router) avec API Node.js, SQLite sur volume persistant, comptes membres et interface responsive.

## Déploiement production avec Docker

Le déploiement prévu est une instance applicative unique, derrière Caddy pour le HTTPS automatique. SQLite est adapté à ce mode de déploiement ; ne lancez pas plusieurs réplicas de l’application sur ce même fichier de base.

1. Faites pointer le DNS `A`/`AAAA` de votre domaine vers le serveur. Ouvrez les ports 80 et 443.
2. Copiez `.env.example` en `.env`, puis définissez `SITE_ADDRESS`, `ADMIN_EMAIL`, `ADMIN_NAME` et un mot de passe unique de 16 caractères minimum pour `ADMIN_PASSWORD`.
3. Lancez :

   ```sh
   docker compose up -d --build
   ```

4. Ouvrez `https://<SITE_ADDRESS>` et connectez-vous avec le compte administrateur configuré.

Caddy demande et renouvelle le certificat TLS. Les sessions utilisent un cookie HTTP-only, SameSite et Secure en production. Les mots de passe sont hachés avec scrypt. Les routes de données et de fichiers exigent une session et vérifient l’appartenance au projet actif. Toute personne peut créer un compte avec son premier projet privé ; elle en devient administratrice. Un administrateur de projet peut inviter des membres au moyen d’un lien unique valable sept jours. Les messages, fichiers, rendus, tâches, événements et membres sont isolés par projet. Un membre peut créer plusieurs projets et changer d’espace depuis le sélecteur en haut de l’interface.

La base SQLite et les fichiers envoyés sont gardés dans le volume Docker `latelier-data`. Le déploiement crée une base vide sans contenu de démonstration. Pour mettre à jour, lancez `docker compose up -d --build` : le volume de données reste en place.

Pour récupérer un compte administrateur, modifiez `ADMIN_PASSWORD` dans `.env`, puis exécutez `docker compose up -d` et `docker compose exec app npm run admin:reset`. Cette commande invalide les sessions administrateur précédentes.

Sauvegardez régulièrement le volume `latelier-data` et testez la restauration. Pour plusieurs instances applicatives ou du trafic important, remplacez SQLite et son volume partagé par PostgreSQL et un stockage objet avant d’ajouter des réplicas.

## Développement local

Prérequis : Node.js 22 et npm. Créez `.env.local` avec ces variables :

```dotenv
ADMIN_EMAIL=admin@example.com
ADMIN_NAME=Administrateur
ADMIN_PASSWORD=un-mot-de-passe-local-long-et-unique
```

Puis :

```sh
npm ci
npm run dev
```

Ouvrez `http://127.0.0.1:3000`. En développement, des données d’exemple sont initialisées au premier démarrage. La base et les pièces jointes sont écrites dans `data/`.

## Fonctions

- Inscription publique avec création du premier projet, connexion, déconnexion et changement de mot de passe.
- Messages avec pièces jointes téléversées et téléchargeables (20 Mo maximum).
- Rendus, changement de statut, tâches, événements, calendrier, recherche locale et synthèse des messages/tâches.
- Assistant de recherche dans les contenus de l’espace.

Les invitations sont distribuées par lien copié dans le presse-papiers. Aucun service d’envoi d’e-mail ni fournisseur audio n’est configuré ; le salon vocal est donc un point d’extension d’interface. Le premier démarrage migre les données existantes vers le projet « Collectif design » sans supprimer les contenus déjà enregistrés.
