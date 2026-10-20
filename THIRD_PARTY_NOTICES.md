# Third-party notices

## ggwave

Earshot's acoustic modem is [ggwave](https://github.com/ggerganov/ggwave) by Georgi Gerganov, MIT License (npm package `ggwave@0.4.0`).

## Text compression model (`src/compress/model-data.json`)

The compressor's vocabulary was selected from the byte-pair-encoding merges of OpenAI's GPT-2 tokenizer, and its token frequencies were measured on the corpora below. The model file contains only token byte strings and frequency counts.

### GPT-2 tokenizer merges

Source: https://github.com/openai/gpt-2 (`vocab.bpe`)

```
Modified MIT License

Software Copyright (c) 2019 OpenAI

We don't claim ownership of the content you create with GPT-2, so it is yours to do with as you please.
We only ask that you use GPT-2 responsibly and clearly indicate your content was created using GPT-2.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.
The above copyright notice and this permission notice need not be included
with content created by the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
OR OTHER DEALINGS IN THE SOFTWARE.
```

### Tatoeba

Token frequencies were trained on English sentences from [Tatoeba](https://tatoeba.org), licensed under [CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/). © Tatoeba contributors.

### Project Gutenberg

*The Adventures of Sherlock Holmes* by Arthur Conan Doyle (Project Gutenberg eBook #1661), public domain in the USA.
