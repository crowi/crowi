FROM docker.elastic.co/elasticsearch/elasticsearch:6.3.2

RUN elasticsearch-plugin install https://github.com/WorksApplications/elasticsearch-sudachi/releases/download/v6.3.2-1.1.0/analysis-sudachi-elasticsearch6.3.2-1.1.0.zip
RUN curl -L https://github.com/WorksApplications/Sudachi/releases/download/v0.1.0/sudachi-0.1.0-dictionary-core.zip -o system_core.dic.zip && unzip system_core.dic.zip -d /usr/share/elasticsearch/config/sudachi_tokenizer/ && rm system_core.dic.zip

