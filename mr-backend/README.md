# MR Removal Render Backend

Temporary Render deployment of the Flask processing API. The static UI may remain local and call this service over HTTPS.

Required secret:

- `YT_AUDIO_WORKER_TOKEN`

Recommended settings for the temporary verification service:

- Root directory: `mr-backend`
- Runtime: Docker
- Health check path: `/health`
- Plan: Free
- `FRONTEND_ORIGINS=http://127.0.0.1:4173,http://localhost:4173`
