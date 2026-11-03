---
title: "Chat E2EE Message Flow"
ticket: "E2EE-30"
status: "planned"
draft: false
weight: 40
---

# E2EE-30 Message Flow: интеграция в UI

## Depends on
- `E2EE-10`, `E2EE-20`

## Goal
Пользователь вводит парольную фразу комнаты; отправка шифрует, приём/история
расшифровывают. Ключ живёт только в памяти вкладки.

## Scope

### Join flow (`assets/js/chat/chat-ui/`)
- `join-form-handler.ts`: добавить обязательное поле passphrase
  (type=password, min 8 символов после trim — клиентская валидация по
  образцу `MAX_NICKNAME_LEN`)
- `template.ts` join-формы: разметка поля + подсказка «фразу задаёт создатель
  комнаты, передавайте вне чата»
- `state.ts`: хранить `Promise<CryptoKey>` (результат `deriveRoomKey`);
  вывод ключа стартует сразу при сабмите — PBKDF2 ~0.5с не блокирует join

### Отправка (`assets/js/chat/chat-ui/message-form-handler.ts`)
- Валидация plaintext 1..200 символов остаётся на клиенте как сейчас
- Перед `serializeCommand`: `body = await encryptBody(key, slug, text)`
  → в `ClientMessage.body` идут байты конверта
- `protocol/outgoing.ts`: `validateOutgoingCommand` для message проверяет
  байтовый body (не пустой), строковые проверки переносятся на этап выше

### Приём и история (`assets/js/chat/messages/handler.ts`, `template.ts`)
- `renderMessage` становится асинхронной по body: decryptBody → текст;
  `{ok:false}` → плейсхолдер `🔒 зашифрованное сообщение`
  (не выдавать причину: не та фраза или мусор)
- History из `ServerJoined` потока прогоняется через тот же путь
- Шаблон сообщения получает уже расшифрованный текст; сигнатуру
  `chatMessageTemplate` не менять (принимает string)

### Сессия
- Ключ НЕ персистится (никаких IndexedDB/localStorage). F5 = повторный ввод
  фразы. Осознанное ограничение v1, опция «запомнить во вкладке»
  (sessionStorage) — отдельным решением после ревью.

### Voice
- Не трогаем: RTP идёт P2P с DTLS-SRTP, контент не проходит через сервер.

## Deliverables
- Обновлённые join/message формы и state
- Асинхронный расшифровывающий рендер сообщений
- Сквозная работа: два браузерных контекста с одной фразой видят текст друг
  друга

## Tests
- Unit: message-form-handler отклоняет пустую/короткую фразу до крипты
- Integration (e2e, `tests/e2e/run.sh suites/chat-e2ee`):
  - контекст A создаёт комнату с фразой, шлёт сообщение
  - контекст B входит с той же фразой → видит текст в истории и live
  - контекст C входит с неверной фразой → видит 🔒-плейсхолдеры,
    свои сообщения A/B не читает
- Перезагрузка страницы требует повторного ввода фразы

## Acceptance
- Полный цикл обмена сообщениями работает в браузере
- Неверная фраза не ломает страницу (только плейсхолдеры)
