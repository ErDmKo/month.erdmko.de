---
title: "Chat E2EE Crypto Core"
ticket: "E2EE-20"
status: "planned"
draft: false
weight: 30
---

# E2EE-20 Crypto Core (TypeScript)

## Depends on
- нет (параллелится с `E2EE-10`); для интеграции нужен `E2EE-00`

## Goal
Изолированный клиентский модуль: вывод ключа из парольной фразы комнаты и
шифрование/расшифрование байтовых payload'ов. Только нативный WebCrypto,
ноль новых зависимостей.

## Формат конверта (freeze)

```
body bytes = [0x01] [nonce 12 байт] [ ciphertext ] [tag 16 байт]
             версия  └── AES-GCM params ──┘   └─ AES-GCM output ─┘
```
- Алгоритм: `AES-GCM`, ключ 256 бит, IV 12 байт (random), tagLength 128
- AAD: `TextEncoder().encode(room_slug)` — привязывает шифротекст к комнате
- Версия в первом байте — запас на будущую смену алгоритма

## KDF

```
baseKey  = crypto.subtle.importKey('raw', TextEncoder(passphrase), 'PBKDF2')
salt     = TextEncoder().encode(`month:e2ee:v1:${room_slug}`)   // детерминированная
key      = crypto.subtle.deriveKey(
             {name:'PBKDF2', salt, iterations:600000, hash:'SHA-256'},
             baseKey, {name:'AES-GCM', length:256}, false /*not extractable*/,
             ['encrypt','decrypt'])
```

Соль детерминирована от slug → все участники выводят одинаковый ключ без
серверного обмена ключами. Смена фразы = смена ключа (история старой фразы
не читается новой — задокументировать).

## Scope

### Новый каталог `assets/js/chat/crypto/`
- `derive.ts`: `deriveRoomKey(ctx, roomSlug, passphrase): Promise<CryptoKey>`
  + кэш ключа по slug в замыкании (повторные вызовы не пересчитывают PBKDF2)
- `envelope.ts`: `encryptBody(ctx, key, roomSlug, plaintext): Promise<Uint8Array>`
  и `decryptBody(ctx, key, roomSlug, body): Promise<Uint8Array>`; ошибки
  расшифровки возвращают типизированный результат (`{ok:true}|{ok:false}`),
  НЕ кидают исключения наружу; проверка `body[0] === 0x01`
- BUILD.bazel по образцу соседних целей `//assets/js/chat/...`
- Константы (`iterations`, размеры, версия) — в одном месте

### Тесты `assets/js/chat/crypto/crypto.test.ts`
WebCrypto доступен в Node 20 как `globalThis.crypto.subtle` — тесты идут
через bazel js_test без браузера. Контекст `ctx` собрать как в других тестах.

## Deliverables
- `assets/js/chat/crypto/{derive.ts,envelope.ts}`
- Юнит-тесты, зарегистрированные в `assets/js/BUILD.bazel`

## Tests
- Roundtrip: encrypt→decrypt возвращает исходный текст (включая кириллицу
  и эмодзи)
- Детерминизм KDF: одинаковые slug+phrase дают одинаковый сырой ключ
  (для теста derive с extractable=true через отдельную test-only функцию)
- Разная фраза / разный slug → decrypt возвращает `{ok:false}`
- Tamper: флип одного байта шифротекста → `{ok:false}` (GCM auth)
- AAD: шифротекст из комнаты A не расшифровывается ключом комнаты B
- Nonce uniqueness: 10 000 шифрований — все nonce различны
- Конверт: длина выхода = 29 + len(plaintext UTF-8); первый байт 0x01

## Acceptance
- `bazel test //assets/js:all` зелёный
- Модуль не импортирует ничего из DOM/UI — чистая логика
