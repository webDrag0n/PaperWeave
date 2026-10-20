#!/usr/bin/env python3
"""生成 PaperWeave 示例论文 PDF（带 DOI、摘要、互相引用的参考文献段落）"""
import os
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'samples')
os.makedirs(OUT, exist_ok=True)

W, H = A4

PAPERS = [
    {
        "file": "attention.pdf",
        "title": "Attention Is All You Need",
        "authors": "Ashish Vaswani, Noam Shazeer, Niki Parmar",
        "year": "2017", "doi": "10.48550/arXiv.1706.03762",
        "abstract": "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.",
        "refs": [
            "[1] J. Devlin, M. Chang. BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding. NAACL 2019.",
            "[2] A. Radford. Improving Language Understanding by Generative Pre-Training. OpenAI 2018.",
            "[3] I. Sutskever. Sequence to Sequence Learning with Neural Networks. NeurIPS 2014.",
        ],
    },
    {
        "file": "bert.pdf",
        "title": "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
        "authors": "Jacob Devlin, Ming-Wei Chang, Kenton Lee",
        "year": "2019", "doi": "10.18653/v1/N19-1423",
        "abstract": "We introduce a new language representation model called BERT, which stands for Bidirectional Encoder Representations from Transformers. BERT obtains new state-of-the-art results on eleven natural language processing tasks.",
        "refs": [
            "[1] A. Vaswani, N. Shazeer. Attention Is All You Need. NeurIPS 2017. doi:10.48550/arXiv.1706.03762",
            "[2] A. Radford. Improving Language Understanding by Generative Pre-Training. OpenAI 2018.",
        ],
    },
    {
        "file": "gpt.pdf",
        "title": "Improving Language Understanding by Generative Pre-Training",
        "authors": "Alec Radford, Karthik Narasimhan, Tim Salimans",
        "year": "2018", "doi": "10.48550/arXiv.1801.06146",
        "abstract": "We demonstrate that large gains on diverse natural language understanding tasks can be realized by generative pre-training of a language model on a diverse corpus of unlabeled text, followed by discriminative fine-tuning on each specific task.",
        "refs": [
            "[1] A. Vaswani. Attention Is All You Need. NeurIPS 2017.",
        ],
    },
    {
        "file": "s2s.pdf",
        "title": "Sequence to Sequence Learning with Neural Networks",
        "authors": "Ilya Sutskever, Oriol Vinyals, Quoc V. Le",
        "year": "2014", "doi": "10.48550/arXiv.1409.3215",
        "abstract": "This paper presents a general end-to-end approach to sequence learning that makes minimal assumptions on the sequence structure. Our method uses a multilayered Long Short-Term Memory (LSTM) to map the input sequence to a vector of a fixed dimensionality.",
        "refs": [],
    },
    {
        "file": "resnet.pdf",
        "title": "Deep Residual Learning for Image Recognition",
        "authors": "Kaiming He, Xiangyu Zhang, Shaoqing Ren",
        "year": "2016", "doi": "10.1109/CVPR.2016.90",
        "abstract": "Deeper neural networks are more difficult to train. We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously. We explicitly reformulate the layers as learning residual functions.",
        "refs": [],
    },
    {
        "file": "vit.pdf",
        "title": "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale",
        "authors": "Alexey Dosovitskiy, Lucas Beyer, Alexander Kolesnikov",
        "year": "2021", "doi": "10.48550/arXiv.2010.11929",
        "abstract": "While the Transformer architecture has become the de-facto standard for natural language processing tasks, its applications to computer vision remain limited. We show that a pure transformer applied directly to sequences of image patches can perform very well on image classification tasks.",
        "refs": [
            "[1] A. Vaswani, N. Shazeer, N. Parmar. Attention Is All You Need. NeurIPS 2017.",
            "[2] K. He, X. Zhang, S. Ren. Deep Residual Learning for Image Recognition. CVPR 2016. doi:10.1109/CVPR.2016.90",
            "[3] J. Devlin. BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding. 2019.",
        ],
    },
]


def draw_paper(path, meta):
    c = canvas.Canvas(path, pagesize=A4)
    c.setTitle(meta["title"])
    c.setAuthor(meta["authors"])
    # 第 1 页：标题、作者、DOI、摘要、正文
    y = H - 80
    c.setFont("Helvetica-Bold", 16)
    # 标题换行
    words = meta["title"].split()
    line = ""
    for w in words:
        if len(line + " " + w) > 70:
            c.drawString(60, y, line); y -= 22; line = w
        else:
            line = (line + " " + w).strip()
    c.drawString(60, y, line); y -= 30
    c.setFont("Helvetica", 11)
    c.drawString(60, y, meta["authors"]); y -= 18
    c.setFont("Helvetica-Oblique", 10)
    c.drawString(60, y, f"Year {meta['year']}    doi:{meta['doi']}"); y -= 30
    c.setFont("Helvetica-Bold", 12)
    c.drawString(60, y, "Abstract"); y -= 16
    c.setFont("Helvetica", 10)
    words = meta["abstract"].split()
    line = ""
    for w in words:
        if len(line + " " + w) > 92:
            c.drawString(60, y, line); y -= 13; line = w
        else:
            line = (line + " " + w).strip()
    if line:
        c.drawString(60, y, line); y -= 13
    y -= 20
    c.setFont("Helvetica-Bold", 12)
    c.drawString(60, y, "1. Introduction"); y -= 16
    c.setFont("Helvetica", 10)
    filler = ("This paper studies the problem in a principled way. We describe the method, "
              "the theory behind it, and extensive experiments that validate the approach. "
              "The results show clear improvements over prior work across benchmarks. ")
    for _ in range(3):
        words = filler.split()
        line = ""
        for w in words:
            if len(line + " " + w) > 92:
                c.drawString(60, y, line); y -= 13; line = w
            else:
                line = (line + " " + w).strip()
        if line:
            c.drawString(60, y, line); y -= 13
        y -= 6
    c.showPage()
    # 第 2 页：方法正文
    c.setFont("Helvetica-Bold", 12)
    c.drawString(60, H - 80, "2. Method")
    c.setFont("Helvetica", 10)
    y = H - 100
    for _ in range(4):
        words = filler.split()
        line = ""
        for w in words:
            if len(line + " " + w) > 92:
                c.drawString(60, y, line); y -= 13; line = w
            else:
                line = (line + " " + w).strip()
        if line:
            c.drawString(60, y, line); y -= 13
        y -= 6
    c.showPage()
    # 第 3 页：参考文献
    c.setFont("Helvetica-Bold", 12)
    c.drawString(60, H - 80, "References")
    y = H - 104
    c.setFont("Helvetica", 10)
    for r in meta["refs"]:
        for chunk in [r[i:i + 95] for i in range(0, len(r), 95)]:
            c.drawString(60, y, chunk)
            y -= 14
        y -= 4
    c.showPage()
    c.save()


manifest = []
for m in PAPERS:
    draw_paper(os.path.join(OUT, m["file"]), m)
    manifest.append({
        "file": m["file"], "title": m["title"],
        "authors": [a.strip() for a in m["authors"].split(",")],
        "year": m["year"], "doi": m["doi"], "abstract": m["abstract"],
    })

import json
with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=1)

print(f"generated {len(PAPERS)} sample PDFs in {os.path.abspath(OUT)}")
