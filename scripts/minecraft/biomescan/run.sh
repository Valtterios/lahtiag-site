#!/bin/sh
# Compile once, then run: run.sh <BiomeScan args>
cd /scan
JAVA=/usr/lib/jvm/temurin-25-jdk-amd64/bin
CP="bundle/META-INF/versions/26.3-rc-2/server-26.3-rc-2.jar:$(find bundle/META-INF/libraries -name '*.jar' | tr '\n' ':')"
[ -f out/BiomeScan.class ] || { mkdir -p out && $JAVA/javac -cp "$CP" -d out BiomeScan.java || exit 1; }
exec $JAVA/java -Xmx3G -cp "out:$CP" BiomeScan "$@"
