# Указатель раздела volna

Указатель разбит по этапам: превышен порог объёма. Этап открывает только свой файл.

Маршрут выбирается по колонкам «предмет», «тип» и «описание»: открывать нужно один узел,
а не раздел. Подходит несколько - открывать по одному, начиная с ближайшего к задаче.

| Куда | Вид | Предмет | Тип | Этапы | Описание |
|---|---|---|---|---|---|
| [analyze](INDEX--analyze.md) | узел · 6 | возврат к задаче, деление крупной работы, подагенты во флоу | договорённость ×2, ограничение ×2, порядок | analyze, spec, plan, implement, capture, deliver, intake | - |
| [spec](INDEX--spec.md) | узел · 2 | деление крупной работы, остановы и вопросы | договорённость ×2 | analyze, spec, plan, deliver, close, intake | - |
| [plan](INDEX--plan.md) | узел · 12 | автопроход, длинная задача, где живёт состояние, деление крупной работы | ограничение ×5, порядок ×3, договорённость ×2 | analyze, spec, plan, implement, visual, capture, deliver, close, intake | - |
| [implement](INDEX--implement.md) | узел · 17 | автопроход, длинная задача, адвокат на задаче без кода, возврат к задаче | ограничение ×5, порядок ×5, приём ×3 | analyze, plan, implement, advocate, unit-tests, visual, capture, deliver, close, intake | - |
| [advocate](INDEX--advocate.md) | узел · 2 | адвокат на задаче без кода, возврат к этапу | порядок, приём | implement, advocate, unit-tests, visual | - |
| [unit-tests](INDEX--unit-tests.md) | узел · 2 | возврат к этапу, обновление плагина | ограничение, порядок | implement, advocate, unit-tests, visual | - |
| [visual](INDEX--visual.md) | узел · 3 | возврат к этапу, графика в печатной версии, сверка локального артефакта | ограничение, порядок, приём | plan, implement, advocate, unit-tests, visual | - |
| [capture](INDEX--capture.md) | узел · 20 | автопроход, длинная задача, архивные журналы, возврат к задаче | порядок ×7, договорённость ×4, ограничение ×3 | analyze, plan, implement, capture, deliver, close, cleanup, intake | - |
| [deliver](INDEX--deliver.md) | узел · 7 | активная задача и гейт, ключи state.json, место этапа capture | договорённость ×2, побочный эффект ×2, гейт | analyze, spec, plan, implement, capture, deliver, close, cleanup, intake | - |
| [close](INDEX--close.md) | узел · 3 | метки времени в журнале, остановы и вопросы, профиль проекта | договорённость ×3 | spec, plan, implement, capture, deliver, close, intake | - |
| [cleanup](INDEX--cleanup.md) | узел · 3 | активная задача и гейт, архивные журналы, изоляция плагина | договорённость, ограничение, побочный эффект | capture, deliver, cleanup, intake | - |
| [intake](INDEX--intake.md) | узел · 7 | профиль проекта, возврат к задаче, граница репозитория | договорённость ×2, гейт, ограничение | analyze, spec, plan, implement, capture, deliver, close, cleanup, intake | - |