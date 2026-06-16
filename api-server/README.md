# API Server (Track B)

機械対機械の利用向け REST API。v1 のサーバー実装をそのまま配置する。

```
api-server/
├── backend/
│   ├── main.py / cache.py / engines.py / router.py / config.py / ...
│   ├── Dockerfile
│   └── requirements.txt
└── deploy/
    ├── docker-compose.yml
    └── nginx.conf
```

詳細は v1 の README（または `../docs/01_design.md` の §3 Track B）を参照。

**注意**: Web UI（GitHub Pages）はこの API を使わなくても動作する。  
API を使う場合のみ、ユーザーは UI の設定画面でこのサーバーの URL を入力する。
