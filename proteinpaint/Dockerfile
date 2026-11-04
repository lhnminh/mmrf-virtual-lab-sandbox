FROM ghcr.io/stjude/ppserver:2.214.0-b33a2fad7@sha256:4242772b10e43839f340f7120809eea9f4dbbf2d665ac250f06ba44b908602b6
USER root
WORKDIR /home/root/pp/app/active
# MSigDB 2023.2.Hs (CC BY 4.0) in ProteinPaint's prebuilt gene set termdb format, as St. Jude
# publishes it for public installs (proteinpaint utils/public-support-files-download.sh).
# It backs the "Prebuilt gene set" picker. This early layer keeps the 566 MB download cached.
RUN mkdir -p /home/root/pp/tp/anno/msigdb && curl -fsSL --retry 3 -o /home/root/pp/tp/anno/msigdb/db_2023.2.Hs \
    https://proteinpaint.stjude.org/ppSupport/msigdb/db_2023.2.Hs && \
    echo '76f488642268dd30036df914d18c26073a81cfeb07c478ceecf91b0279685222  /home/root/pp/tp/anno/msigdb/db_2023.2.Hs' | sha256sum -c -
RUN npm pkg set type=module && npm install --save-exact @sjcrh/proteinpaint-server@2.216.0 @sjcrh/proteinpaint-shared@2.216.0
COPY scripts/patch_proteinpaint.mjs /tmp/patch_proteinpaint.mjs
RUN node /tmp/patch_proteinpaint.mjs node_modules/@sjcrh/proteinpaint-server
COPY proteinpaint/serverconfig.json ./serverconfig.json
COPY proteinpaint/genome.mjs ./genome/synthetic.mjs
COPY proteinpaint/dataset.mjs ./dataset/synthetic.mjs
COPY generated /home/root/pp/tp
COPY synthetic/generate_assays.py /tmp/generate_assays.py
COPY synthetic/embedding.py /tmp/embedding.py
RUN apt-get update && apt-get install -y --no-install-recommends tabix && rm -rf /var/lib/apt/lists/* && /opt/venv/bin/python /tmp/generate_assays.py
RUN bcftools view -Ob -o /home/root/pp/tp/variants.bcf.gz /home/root/pp/tp/variants.vcf && bcftools index /home/root/pp/tp/variants.bcf.gz
