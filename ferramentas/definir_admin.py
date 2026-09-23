"""
Aplica a custom claim admin=true ao usuário do secret MAPALEADS_ADMIN_UID.

Só o servidor (Admin SDK) consegue gravar custom claims: o usuário não consegue
se promover sozinho. Roda pelo workflow "Definir admin" (Actions > Run workflow).
Também cria/atualiza /config/geral com o limite diário padrão aprovado (20).
Log público: só status, nunca UID ou e-mail.
"""

import json
import os
import sys

import firebase_admin
from firebase_admin import auth, credentials, firestore

LIMITE_DIARIO_PADRAO = 20  # aprovado pelo Breno


def main():
    conteudo = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    uid = os.environ.get("MAPALEADS_ADMIN_UID", "").strip()
    if not conteudo or not uid:
        print("ERRO: configure os secrets FIREBASE_SERVICE_ACCOUNT e MAPALEADS_ADMIN_UID.")
        sys.exit(1)
    firebase_admin.initialize_app(credentials.Certificate(json.loads(conteudo)))

    try:
        usuario = auth.get_user(uid)
    except auth.UserNotFoundError:
        print("ERRO: o UID do secret MAPALEADS_ADMIN_UID não existe no Firebase Authentication.")
        sys.exit(1)

    claims = dict(usuario.custom_claims or {})
    claims["admin"] = True
    auth.set_custom_user_claims(uid, claims)

    db = firestore.client()
    geral = db.collection("config").document("geral")
    if not geral.get().exists:
        geral.set({"limite_padrao": LIMITE_DIARIO_PADRAO, "fuso": "America/Fortaleza"})
    db.collection("usuarios").document(uid).set({"email": usuario.email or "", "removido": False}, merge=True)

    print("Claim de administrador aplicada. Saia e entre de novo na tela para valer.")


if __name__ == "__main__":
    main()
